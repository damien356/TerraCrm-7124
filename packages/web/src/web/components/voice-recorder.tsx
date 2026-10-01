import * as React from "react";

/**
 * The browser microphone, shared by voice quotes and voice memos.
 * Records webm where the browser can (Chrome, Android), mp4 on Safari and iOS.
 */
export type RecorderStage = "idle" | "recording" | "recorded" | "uploading" | "processing" | "done" | "error";

export function useRecorder() {
  const [stage, setStage] = React.useState<RecorderStage>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [blob, setBlob] = React.useState<Blob | null>(null);
  const [seconds, setSeconds] = React.useState(0);
  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const discardRef = React.useRef(false);
  const aliveRef = React.useRef(true);

  const clearTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const start = async () => {
    setError(null);
    discardRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Closed while the permission prompt was up: let the microphone go.
      if (!aliveRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        if (discardRef.current) return;
        setBlob(new Blob(chunksRef.current, { type: mimeType }));
        setStage("recorded");
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setSeconds(0);
      setStage("recording");
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch {
      setError("Could not access the microphone. Check the browser has permission and try again.");
      setStage("error");
    }
  };

  const stop = () => {
    clearTimer();
    if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
  };

  const reset = () => {
    setBlob(null);
    setSeconds(0);
    setStage("idle");
    setError(null);
  };

  /** Stop and throw the recording away, e.g. the window was closed mid-sentence. */
  const cancel = () => {
    discardRef.current = true;
    stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    reset();
  };

  // Never leave the microphone light on after the component goes.
  React.useEffect(() => {
    aliveRef.current = true;
    discardRef.current = false;
    return () => {
      aliveRef.current = false;
      discardRef.current = true;
      clearTimer();
      if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return { stage, setStage, error, setError, blob, seconds, start, stop, reset, cancel };
}

/** One object URL per recording, freed when the recording changes or the owner unmounts. */
export function usePlaybackUrl(blob: Blob | null) {
  const url = React.useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob]);
  React.useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  return url;
}

export const clock = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
