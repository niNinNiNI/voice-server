package demo;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.zip.*;
import javax.sound.sampled.*;
import okhttp3.*;
import okio.ByteString;

public class Main {
    // 协议常量 - 参考Go版本的常量定义
    private static final byte PROTOCOL_VERSION = 0b0001;
    private static final byte DEFAULT_HEADER_SIZE = 0b0001;
    
    // Message Type
    private static final byte CLIENT_FULL_REQUEST = 0b0001;
    private static final byte CLIENT_AUDIO_ONLY_REQUEST = 0b0010;
    private static final byte SERVER_FULL_RESPONSE = 0b1001;
    private static final byte SERVER_ERROR_RESPONSE = 0b1111;
    
    // Message Type Specific Flags
    private static final byte NO_SEQUENCE = 0b0000;
    private static final byte POS_SEQUENCE = 0b0001;
    private static final byte NEG_SEQUENCE = 0b0010;
    private static final byte NEG_WITH_SEQUENCE = 0b0011;
    
    // Serialization Type
    private static final byte NO_SERIALIZATION = 0b0000;
    private static final byte JSON = 0b0001;
    
    // Compression Type
    private static final byte GZIP = 0b0001;
    
    // 音频处理常量
    private static final int DEFAULT_SAMPLE_RATE = 16000;
    private static final int DEFAULT_BITS = 16;
    private static final int DEFAULT_CHANNELS = 1;
    private static final int DEFAULT_SEGMENT_DURATION_MS = 200;

    // 线程控制
    private static volatile boolean isRunning = true;
    private static final BlockingQueue<byte[]> responseQueue = new LinkedBlockingQueue<>();
    private static final ExecutorService executor = Executors.newFixedThreadPool(2);

    // 音频处理工具类
    static class AudioUtils {
        /**
         * 检查是否为WAV格式
         */
        public static boolean isWavFormat(byte[] data) {
            if (data.length < 44) {
                return false;
            }
            return data[0] == 'R' && data[1] == 'I' && data[2] == 'F' && data[3] == 'F' &&
                   data[8] == 'W' && data[9] == 'A' && data[10] == 'V' && data[11] == 'E';
        }

        /**
         * 读取音频文件数据
         */
        public static byte[] readAudioData(String audioPath) throws IOException {
            File audioFile = new File(audioPath);
            if (!audioFile.exists()) {
                throw new FileNotFoundException("Audio file not found: " + audioPath);
            }
            
            // 读取完整文件内容
            try (FileInputStream fis = new FileInputStream(audioFile);
                 ByteArrayOutputStream baos = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[4096];
                int bytesRead;
                while ((bytesRead = fis.read(buffer)) != -1) {
                    baos.write(buffer, 0, bytesRead);
                }
                return baos.toByteArray();
            }
        }

        /**
         * 解析WAV文件信息
         */
        public static AudioInfo parseWavInfo(byte[] data) {
            if (!isWavFormat(data)) {
                throw new IllegalArgumentException("Not a valid WAV file");
            }
            
            // 使用小端序解析WAV头
            // 声道数：偏移量22-23
            int channels = ((data[23] & 0xFF) << 8) | (data[22] & 0xFF);
            
            // 采样率：偏移量24-27
            int sampleRate = ((data[27] & 0xFF) << 24) | ((data[26] & 0xFF) << 16) | 
                           ((data[25] & 0xFF) << 8) | (data[24] & 0xFF);
            
            // 位深度：偏移量34-35
            int bitsPerSample = ((data[35] & 0xFF) << 8) | (data[34] & 0xFF);
            
            System.out.println("解析WAV信息: 声道数=" + channels + ", 采样率=" + sampleRate + ", 位深度=" + bitsPerSample);
            
            return new AudioInfo(sampleRate, channels, bitsPerSample);
        }
        
        /**
         * 计算分段大小
         */
        public static int calculateSegmentSize(AudioInfo audioInfo, int segmentDurationMs) {
            // 与Go版本保持一致：sampwidth = bitsPerSample / 8
            int sampWidth = audioInfo.bitsPerSample / 8;
            int bytesPerSec = audioInfo.channels * sampWidth * audioInfo.sampleRate;
            int segmentSize = bytesPerSec * segmentDurationMs / 1000;
            System.out.println("计算分段大小: 声道数=" + audioInfo.channels + 
                             ", 采样宽度=" + sampWidth + 
                             ", 采样率=" + audioInfo.sampleRate + 
                             ", 分段大小=" + segmentSize + " 字节");
            return segmentSize;
        }
        
        /**
         * 提取WAV文件的纯音频数据
         */
        public static byte[] extractWavAudioData(byte[] wavData) {
            if (!isWavFormat(wavData)) {
                throw new IllegalArgumentException("Not a valid WAV file");
            }
            
            // 查找data子块
            int pos = 36;
            while (pos < wavData.length - 8) {
                // 检查是否为data子块
                if (wavData[pos] == 'd' && wavData[pos + 1] == 'a' && 
                    wavData[pos + 2] == 't' && wavData[pos + 3] == 'a') {
                    
                    // 读取data子块大小（小端序）
                    int dataSize = ((wavData[pos + 7] & 0xFF) << 24) | 
                                 ((wavData[pos + 6] & 0xFF) << 16) | 
                                 ((wavData[pos + 5] & 0xFF) << 8) | 
                                 (wavData[pos + 4] & 0xFF);
                    
                    System.out.println("找到data子块，大小: " + dataSize + " 字节");
                    
                    // 提取音频数据
                    byte[] audioData = new byte[dataSize];
                    System.arraycopy(wavData, pos + 8, audioData, 0, dataSize);
                    
                    return audioData;
                }
                pos++;
            }
            
            throw new IllegalArgumentException("No data subchunk found in WAV file");
        }
        
        /**
         * 分割音频数据
         */
        public static List<byte[]> splitAudio(byte[] audioData, int segmentSize) {
            List<byte[]> segments = new ArrayList<>();
            for (int offset = 0; offset < audioData.length; offset += segmentSize) {
                int len = Math.min(segmentSize, audioData.length - offset);
                byte[] segment = new byte[len];
                System.arraycopy(audioData, offset, segment, 0, len);
                segments.add(segment);
            }
            return segments;
        }
    }

    // 音频信息类
    static class AudioInfo {
        public final int sampleRate;
        public final int channels;
        public final int bitsPerSample;
        
        public AudioInfo(int sampleRate, int channels, int bitsPerSample) {
            this.sampleRate = sampleRate;
            this.channels = channels;
            this.bitsPerSample = bitsPerSample;
        }
    }
    
    // 响应解析结果类
    static class AsrResponse {
        public int code;
        public int event;
        public boolean isLastPackage;
        public int payloadSequence;
        public int payloadSize;
        public String payloadMsg;
        
        @Override
        public String toString() {
            return String.format("AsrResponse{code=%d, event=%d, isLastPackage=%s, payloadSequence=%d, payloadSize=%d, payloadMsg='%s'}", 
                code, event, isLastPackage, payloadSequence, payloadSize, payloadMsg);
        }
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 4) {
            System.err.println("需要传入 4 个参数，依次为 url、appId、token 和 audioFilePath");
            System.exit(1);
        }

        final String url = args[0];
        final String appId = args[1];
        final String token = args[2];
        final String audioFilePath = args[3];

        // 创建WebSocket客户端
        OkHttpClient client = new OkHttpClient.Builder()
                .pingInterval(60, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .writeTimeout(60, TimeUnit.SECONDS)
                .callTimeout(60, TimeUnit.SECONDS)
                .build();

        Request request = new Request.Builder()
                .url(url)
                .header("X-Api-App-Key", appId)
                .header("X-Api-Access-Key", token)
                .header("X-Api-Resource-Id", "volc.bigasr.sauc.duration")
                .header("X-Api-Connect-Id", UUID.randomUUID().toString())
                .build();

        WebSocket webSocket = client.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                System.out.println("===> 连接已建立, X-Tt-Logid:" + response.header("X-Tt-Logid"));
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                System.out.println("===> 收到文本消息: " + text);
            }

            @Override
            public void onMessage(WebSocket webSocket, ByteString bytes) {
                responseQueue.offer(bytes.toByteArray());
            }

            @Override
            public void onClosing(WebSocket webSocket, int code, String reason) {
                System.out.println("===> 连接正在关闭: code=" + code + ", reason=" + reason);
                isRunning = false;
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                System.err.println("===> 连接失败: " + t.getMessage());
                isRunning = false;
            }
        });

        // 处理音频文件
        try {
            // 读取完整WAV文件数据
            byte[] fullData = AudioUtils.readAudioData(audioFilePath);
            System.out.println("读取音频文件完成，总大小: " + fullData.length + " 字节");
            
            // 解析WAV信息
            AudioInfo audioInfo = AudioUtils.parseWavInfo(fullData);
            
            System.out.println("音频信息: 采样率=" + audioInfo.sampleRate + 
                             ", 声道数=" + audioInfo.channels + 
                             ", 位深=" + audioInfo.bitsPerSample);
            
            CountDownLatch latch = new CountDownLatch(2);
            
            // 启动发送线程
            executor.submit(() -> {
                try {
                    sendMessages(webSocket, fullData, audioInfo);
                } catch (Exception e) {
                    System.err.println("发送线程出错: " + e.getMessage());
                    isRunning = false;
                } finally {
                    latch.countDown();
                }
            });

            // 启动接收线程
            executor.submit(() -> {
                try {
                    processResponses(webSocket, client);
                } catch (Exception e) {
                    System.err.println("接收线程出错: " + e.getMessage());
                    isRunning = false;
                } finally {
                    latch.countDown();
                }
            });

            // 主线程等待两个子线程执行完毕
            latch.await();
        } catch (Exception e) {
            System.err.println("音频处理失败: " + e.getMessage());
        } finally {
            // 关闭 WebSocket
            if (webSocket != null) {
                webSocket.close(1000, "正常关闭");
            }
            // 关闭自定义线程池
            executor.shutdown();
            try {
                if (!executor.awaitTermination(30, TimeUnit.SECONDS)) {
                    executor.shutdownNow();
                }
            } catch (InterruptedException e) {
                System.err.println("线程中断: " + e.getMessage());
                executor.shutdownNow();
                Thread.currentThread().interrupt();
            }
            // 关闭 OkHttpClient 线程池
            client.dispatcher().executorService().shutdown();
            try {
                if (!client.dispatcher().executorService().awaitTermination(30, TimeUnit.SECONDS)) {
                    client.dispatcher().executorService().shutdownNow();
                }
            } catch (InterruptedException e) {
                System.err.println("线程中断: " + e.getMessage());
                client.dispatcher().executorService().shutdownNow();
                Thread.currentThread().interrupt();
            }
            System.err.println("资源完成关闭");
        }
    }

    private static void sendMessages(WebSocket webSocket, byte[] audioData, AudioInfo audioInfo) throws Exception {
        int seq = 1;
        
        // 发送完整客户端请求
        sendFullClientRequest(webSocket, seq);

        // 计算分段大小
        int segmentSize = AudioUtils.calculateSegmentSize(audioInfo, DEFAULT_SEGMENT_DURATION_MS);
        List<byte[]> audioSegments = AudioUtils.splitAudio(audioData, segmentSize);
        
        // 分片发送音频数据
        for (int i = 0; i < audioSegments.size() && isRunning; i++) {
            byte[] segment = audioSegments.get(i);
            boolean isLast = (i == audioSegments.size() - 1);
            
            seq++;
            int finalSeq = isLast ? -seq : seq;
            
            System.out.println("发送音频分段: 序号 " + seq + ", 长度 " + segment.length + ", 是否最后一段: " + isLast);
            sendAudioSegment(webSocket, segment, isLast, finalSeq);
            Thread.sleep(DEFAULT_SEGMENT_DURATION_MS);
        }
    }

    private static void sendFullClientRequest(WebSocket webSocket, int seq) throws IOException {
        JsonObject user = new JsonObject();
        user.addProperty("uid", "demo_uid");

        JsonObject audio = new JsonObject();
        audio.addProperty("format", "wav");
        audio.addProperty("codec", "raw");
        // 与Go版本保持一致，使用硬编码的音频参数
        audio.addProperty("rate", 16000);
        audio.addProperty("bits", 16);
        audio.addProperty("channel", 1);

        JsonObject request = new JsonObject();
        request.addProperty("model_name", "bigmodel");
        request.addProperty("enable_itn", true);
        request.addProperty("enable_punc", true);
        request.addProperty("enable_ddc", true);
        request.addProperty("show_utterances", true);
        request.addProperty("enable_nonstream", false);

        JsonObject payload = new JsonObject();
        payload.add("user", user);
        payload.add("audio", audio);
        payload.add("request", request);

        System.out.println("发送完整客户端请求: " + payload.toString());

        String payloadStr = payload.toString();
        //这里可以使用JSON复刻payloadStr

        byte[] payloadBytes = gzipCompress(payloadStr.getBytes());
        byte[] header = getHeader(CLIENT_FULL_REQUEST, POS_SEQUENCE, JSON, GZIP, (byte) 0);
        byte[] payloadSize = intToBytes(payloadBytes.length);
        byte[] seqBytes = intToBytes(seq);

        byte[] fullClientRequest = new byte[header.length + seqBytes.length + payloadSize.length + payloadBytes.length];
        System.arraycopy(header, 0, fullClientRequest, 0, header.length);
        System.arraycopy(seqBytes, 0, fullClientRequest, header.length, seqBytes.length);
        System.arraycopy(payloadSize, 0, fullClientRequest, header.length + seqBytes.length, payloadSize.length);
        System.arraycopy(payloadBytes, 0, fullClientRequest, header.length + seqBytes.length + payloadSize.length,
                payloadBytes.length);
        webSocket.send(ByteString.of(fullClientRequest));
    }

    private static void sendAudioSegment(WebSocket webSocket, byte[] buffer, boolean isLast, int seq) {
        byte messageTypeSpecificFlags = isLast ? NEG_WITH_SEQUENCE : POS_SEQUENCE;
        byte[] header = getHeader(CLIENT_AUDIO_ONLY_REQUEST, messageTypeSpecificFlags, JSON, GZIP, (byte) 0);
        byte[] sequenceBytes = intToBytes(seq);
        byte[] payloadBytes = gzipCompress(buffer, buffer.length);
        byte[] payloadSize = intToBytes(payloadBytes.length);

        byte[] audioRequest = new byte[header.length + sequenceBytes.length + payloadSize.length + payloadBytes.length];
        System.arraycopy(header, 0, audioRequest, 0, header.length);
        System.arraycopy(sequenceBytes, 0, audioRequest, header.length, sequenceBytes.length);
        System.arraycopy(payloadSize, 0, audioRequest, header.length + sequenceBytes.length, payloadSize.length);
        System.arraycopy(payloadBytes, 0, audioRequest, header.length + sequenceBytes.length + payloadSize.length,
                payloadBytes.length);

        webSocket.send(ByteString.of(audioRequest));
    }

    private static void processResponses(WebSocket webSocket, OkHttpClient client) {
        while (isRunning || !responseQueue.isEmpty()) {
            try {
                byte[] response = responseQueue.poll(100, TimeUnit.MILLISECONDS);
                if (response != null) {
                    AsrResponse asrResponse = parseResponse(response);
                    System.out.println("收到响应: " + asrResponse);
                    
                    if (asrResponse.isLastPackage) {
                        System.out.println("最后一个包 序号" + asrResponse.payloadSequence + "\n");
                        isRunning = false;
                        // 关闭WebSocket连接
                        webSocket.close(1000, "正常关闭");
                        /// 立即关闭OkHttpClient线程池
                        ExecutorService clientExecutor = client.dispatcher().executorService();
                        clientExecutor.shutdownNow();
                        try {
                            if (!clientExecutor.awaitTermination(15, TimeUnit.SECONDS)) {
                                System.err.println("OkHttp线程池未能及时关闭");
                            }
                        } catch (InterruptedException e) {
                            clientExecutor.shutdownNow();
                            Thread.currentThread().interrupt();
                        }
                    }
                    
                    if (asrResponse.code != 0) {
                        System.err.println("服务器返回错误: " + asrResponse.payloadMsg);
                        isRunning = false;
                    }
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception e) {
                System.err.println("处理响应时出错: " + e.getMessage());
            }
        }
    }

    private static AsrResponse parseResponse(byte[] res) {
        if (res == null || res.length == 0) {
            return new AsrResponse();
        }

        AsrResponse result = new AsrResponse();

        // 解析头部
        int protocolVersion = (res[0] >> 4) & 0x0f;
        int headerSize = res[0] & 0x0f;
        int messageType = (res[1] >> 4) & 0x0f;
        int messageTypeSpecificFlags = res[1] & 0x0f;
        int serializationMethod = (res[2] >> 4) & 0x0f;
        int messageCompression = res[2] & 0x0f;
        int reserved = res[3];

        // 解析payload
        byte[] payload = Arrays.copyOfRange(res, headerSize * 4, res.length);
        
        // 解析messageTypeSpecificFlags
        if ((messageTypeSpecificFlags & 0x01) != 0) {
            result.payloadSequence = bytesToInt(Arrays.copyOfRange(payload, 0, 4));
            payload = Arrays.copyOfRange(payload, 4, payload.length);
        }
        if ((messageTypeSpecificFlags & 0x02) != 0) {
            result.isLastPackage = true;
        }
        if ((messageTypeSpecificFlags & 0x04) != 0) {
            result.event = bytesToInt(Arrays.copyOfRange(payload, 0, 4));
            payload = Arrays.copyOfRange(payload, 4, payload.length);
        }

        // 解析messageType
        switch (messageType) {
            case SERVER_FULL_RESPONSE:
                result.payloadSize = bytesToInt(Arrays.copyOfRange(payload, 0, 4));
                payload = Arrays.copyOfRange(payload, 4, payload.length);
                break;
            case SERVER_ERROR_RESPONSE:
                result.code = bytesToInt(Arrays.copyOfRange(payload, 0, 4));
                result.payloadSize = bytesToInt(Arrays.copyOfRange(payload, 4, 8));
                payload = Arrays.copyOfRange(payload, 8, payload.length);
                break;
        }

        if (payload.length == 0) {
            return result;
        }

        // 是否压缩
        if (messageCompression == GZIP) {
            payload = gzipDecompress(payload);
        }

        // 解析payload
        if (serializationMethod == JSON && payload != null) {
            result.payloadMsg = new String(payload);
        }

        return result;
    }

    // 辅助方法保持不变
    private static byte[] getHeader(byte messageType, byte messageTypeSpecificFlags,
            byte serialMethod, byte compressionType, byte reservedData) {
        final byte[] header = new byte[4];
        header[0] = (byte) ((PROTOCOL_VERSION << 4) | DEFAULT_HEADER_SIZE);
        header[1] = (byte) ((messageType << 4) | messageTypeSpecificFlags);
        header[2] = (byte) ((serialMethod << 4) | compressionType);
        header[3] = reservedData;
        return header;
    }

    private static byte[] intToBytes(int a) {
        return new byte[] {
                (byte) ((a >> 24) & 0xFF),
                (byte) ((a >> 16) & 0xFF),
                (byte) ((a >> 8) & 0xFF),
                (byte) (a & 0xFF)
        };
    }

    private static int bytesToInt(byte[] src) {
        if (src == null || (src.length != 4)) {
            throw new IllegalArgumentException("Invalid byte array for int conversion");
        }
        // 使用大端序（Big Endian）解析，与协议保持一致
        return ((src[0] & 0xFF) << 24)
                | ((src[1] & 0xff) << 16)
                | ((src[2] & 0xff) << 8)
                | ((src[3] & 0xff));
    }

    private static byte[] gzipCompress(byte[] src) {
        return gzipCompress(src, src.length);
    }

    private static byte[] gzipCompress(byte[] src, int len) {
        if (src == null || len == 0) {
            return new byte[0];
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (GZIPOutputStream gzip = new GZIPOutputStream(out)) {
            gzip.write(src, 0, len);
        } catch (IOException e) {
            e.printStackTrace();
            return new byte[0];
        }
        return out.toByteArray();
    }

    private static byte[] gzipDecompress(byte[] src) {
        if (src == null || src.length == 0) {
            return null;
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ByteArrayInputStream ins = new ByteArrayInputStream(src);
        try (GZIPInputStream gzip = new GZIPInputStream(ins)) {
            byte[] buffer = new byte[256];
            int len;
            while ((len = gzip.read(buffer)) > 0) {
                out.write(buffer, 0, len);
            }
        } catch (IOException e) {
            e.printStackTrace();
            return null;
        }
        return out.toByteArray();
    }
}