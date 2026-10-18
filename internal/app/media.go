package app

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"strconv"
	"time"
)

type mediaInfo struct {
	DurationMS int64
	MIME       string
}

const mediaFormats = "aac,amr,asf,flac,matroska,webm,mov,mp3,ogg,wav"

func probe(ctx context.Context, path string) (mediaInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-max_alloc", "67108864", "-protocol_whitelist", "file,pipe", "-format_whitelist", mediaFormats, "-show_entries", "format=duration,format_name:stream=codec_type,duration", "-of", "json", path)
	output, err := cmd.Output()
	if err != nil {
		return mediaInfo{}, &apiError{422, "invalid_audio", "无法读取音频，请检查格式及文件是否完整"}
	}
	var result struct {
		Format struct {
			Duration string `json:"duration"`
			Name     string `json:"format_name"`
		} `json:"format"`
		Streams []struct {
			Type     string `json:"codec_type"`
			Duration string `json:"duration"`
		} `json:"streams"`
	}
	if json.Unmarshal(output, &result) != nil {
		return mediaInfo{}, errors.New("invalid ffprobe output")
	}
	audio := false
	duration, _ := strconv.ParseFloat(result.Format.Duration, 64)
	for _, s := range result.Streams {
		if s.Type == "audio" {
			audio = true
			if d, e := strconv.ParseFloat(s.Duration, 64); e == nil && d > duration {
				duration = d
			}
		}
	}
	if !audio || duration <= 0 || duration > 7*24*3600 {
		return mediaInfo{}, &apiError{422, "invalid_audio", "文件不包含有效音轨或时长无法识别"}
	}
	mime := "application/octet-stream"
	switch result.Format.Name {
	case "wav":
		mime = "audio/wav"
	case "mp3":
		mime = "audio/mpeg"
	case "flac":
		mime = "audio/flac"
	case "ogg":
		mime = "audio/ogg"
	default:
		mime = "audio/mp4"
	}
	return mediaInfo{DurationMS: int64(duration * 1000), MIME: mime}, nil
}
func transcode(ctx context.Context, input, output string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Hour)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-v", "error", "-max_alloc", "67108864", "-protocol_whitelist", "file,pipe", "-format_whitelist", mediaFormats, "-i", input, "-map", "0:a:0", "-vn", "-c:a", "libmp3lame", "-b:a", "128k", "-threads", "1", "-y", output)
	if err := cmd.Run(); err != nil {
		return errors.New("audio preparation failed")
	}
	return nil
}
