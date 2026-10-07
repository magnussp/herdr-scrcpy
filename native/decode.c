// Low-latency H.264 -> RGBA decoder for scrcpy packets.
//
// usage:  scrcpy-decode <path-prefix>
// stdin:  repeated [u32 BE size][u8 flags][size bytes]   flags bit0 = config packet (SPS/PPS)
// output: each frame is written as raw RGBA to "<path-prefix><seq>.rgba", then
//         "<seq> <width> <height>\n" is printed on stdout. Writing the file here
//         keeps the 2+ MB frames out of the pipe and out of the JS heap.
//         RGBA rather than RGB: herdr only forwards RGBA images to the host
//         terminal by file; anything else is re-sent inline as base64.
//
// Each scrcpy media packet is one complete access unit, so packets go straight
// to the decoder without a parser: no frame is held back waiting for the next
// one (the ffmpeg CLI keeps one frame in flight). Config packets are prepended
// to the following packet, like the scrcpy client does. Resolution changes
// (rotation) are handled by re-creating the scaler.
#include <fcntl.h>
#include <libavcodec/avcodec.h>
#include <libavutil/imgutils.h>
#include <libswscale/swscale.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int read_full(void *buf, size_t n) {
    uint8_t *p = buf;
    while (n) {
        ssize_t r = read(0, p, n);
        if (r <= 0) return -1;
        p += r;
        n -= (size_t)r;
    }
    return 0;
}

static int write_full(int fd, const void *buf, size_t n) {
    const uint8_t *p = buf;
    while (n) {
        ssize_t w = write(fd, p, n);
        if (w <= 0) return -1;
        p += w;
        n -= (size_t)w;
    }
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: scrcpy-decode <path-prefix>\n"); return 2; }
    const char *prefix = argv[1];
    char path[4096];
    unsigned long seq = 0;

    const AVCodec *codec = avcodec_find_decoder(AV_CODEC_ID_H264);
    if (!codec) { fprintf(stderr, "no h264 decoder\n"); return 1; }
    AVCodecContext *ctx = avcodec_alloc_context3(codec);
    ctx->flags |= AV_CODEC_FLAG_LOW_DELAY;
    ctx->thread_count = 1; // frame threading would add one frame of delay per thread
    if (avcodec_open2(ctx, codec, NULL) < 0) { fprintf(stderr, "avcodec_open2 failed\n"); return 1; }

    AVPacket *pkt = av_packet_alloc();
    AVFrame *frame = av_frame_alloc();
    struct SwsContext *sws = NULL;
    int sw = 0, sh = 0, sfmt = -1;
    uint8_t *rgb = NULL;
    uint8_t *config = NULL;
    size_t config_len = 0;

    for (;;) {
        uint8_t hdr[5];
        if (read_full(hdr, 5) < 0) break;
        size_t len = ((size_t)hdr[0] << 24) | ((size_t)hdr[1] << 16) | ((size_t)hdr[2] << 8) | hdr[3];
        int is_config = hdr[4] & 1;

        if (is_config) {
            free(config);
            config = malloc(len);
            config_len = len;
            if (read_full(config, len) < 0) break;
            continue;
        }

        size_t total = config_len + len;
        if (av_new_packet(pkt, (int)total) < 0) break;
        if (config_len) memcpy(pkt->data, config, config_len);
        if (read_full(pkt->data + config_len, len) < 0) break;
        free(config);
        config = NULL;
        config_len = 0;

        int ret = avcodec_send_packet(ctx, pkt);
        av_packet_unref(pkt);
        if (ret < 0) { fprintf(stderr, "send_packet: %d\n", ret); continue; }

        while (avcodec_receive_frame(ctx, frame) == 0) {
            if (frame->width != sw || frame->height != sh || frame->format != sfmt) {
                sws_freeContext(sws);
                sw = frame->width; sh = frame->height; sfmt = frame->format;
                sws = sws_getContext(sw, sh, sfmt, sw, sh, AV_PIX_FMT_RGBA, SWS_POINT, NULL, NULL, NULL);
                free(rgb);
                rgb = malloc((size_t)sw * sh * 4);
            }
            uint8_t *dst[4] = { rgb, NULL, NULL, NULL };
            int dst_stride[4] = { sw * 4, 0, 0, 0 };
            sws_scale(sws, (const uint8_t *const *)frame->data, frame->linesize, 0, sh, dst, dst_stride);
            snprintf(path, sizeof path, "%s%lu.rgba", prefix, seq);
            // Never follow or reuse an existing entry: each frame gets a fresh file.
            int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
            if (fd < 0) { perror(path); goto out; }
            int werr = write_full(fd, rgb, (size_t)sw * sh * 4);
            close(fd);
            if (werr < 0) { perror(path); goto out; }
            char line[64];
            int n = snprintf(line, sizeof line, "%lu %d %d\n", seq++, sw, sh);
            if (write_full(1, line, (size_t)n) < 0) goto out;
            av_frame_unref(frame);
        }
    }
out:
    sws_freeContext(sws);
    free(rgb);
    free(config);
    av_frame_free(&frame);
    av_packet_free(&pkt);
    avcodec_free_context(&ctx);
    return 0;
}
