"use client";

import Hls from "hls.js";
import { useEffect, useRef } from "react";

interface HlsVideoProps {
  src: string;
  autoPlay?: boolean;
  muted?: boolean;
  controls?: boolean;
  loop?: boolean;
  style?: React.CSSProperties;
  className?: string;
}

export function HlsVideo({
  src,
  autoPlay = true,
  muted = true,
  controls = true,
  loop = false,
  style,
  className,
}: HlsVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const isHls = src.includes(".m3u8");

    if (isHls && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: false });
      hls.loadSource(src);
      hls.attachMedia(video);
      return () => {
        hls.destroy();
      };
    }

    // Safari has native HLS support, or it's a regular video URL
    video.src = src;
  }, [src]);

  return (
    <video
      ref={videoRef}
      autoPlay={autoPlay}
      muted={muted}
      controls={controls}
      loop={loop}
      playsInline
      style={style}
      className={className}
    />
  );
}
