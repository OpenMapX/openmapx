"use client";

import { useEffect, useMemo, useState } from "react";
import { useMobileRuntimeContext } from "./MobileRuntimeProvider";
import { NativeVoiceInput } from "./nativeVoiceInput";

export function useNativeVoiceInput() {
  const runtime = useMobileRuntimeContext();
  const client =
    runtime.isInstalledShell && runtime.state === "native-compatible" && runtime.handshake
      ? runtime.client
      : null;
  const handshake = runtime.handshake;
  const candidate = useMemo(
    () => (client && handshake ? new NativeVoiceInput(client) : null),
    [client, handshake],
  );
  const [available, setAvailable] = useState<NativeVoiceInput | null>(null);
  useEffect(() => {
    if (!client || !candidate) return;
    let active = true;
    void client
      .request("voice.probe", {})
      .then((reply) => {
        if (active && reply.type === "voice.availability" && reply.payload.available)
          setAvailable(candidate);
      })
      .catch(() => {
        /* Older shells silently reject unknown commands. */
      });
    return () => {
      active = false;
      candidate.cancel();
    };
  }, [client, candidate]);
  // A previous document's positive reply never enables a new client/handshake.
  return available === candidate ? candidate : null;
}
