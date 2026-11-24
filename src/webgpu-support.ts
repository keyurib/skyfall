// Cheap WebGPU capability probe, run before the vgpu bundle is even downloaded.
// An adapter request is the only reliable test: `navigator.gpu` exists on some
// browsers and GPUs (blocklisted drivers, disabled hardware acceleration) that
// cannot actually provide an adapter.

export type WebGpuSupport =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: "no-navigator-gpu" | "no-adapter" | "request-failed" };

export async function detectWebGpu(): Promise<WebGpuSupport> {
  if (typeof navigator === "undefined" || !("gpu" in navigator) || !navigator.gpu) {
    return { supported: false, reason: "no-navigator-gpu" };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter ? { supported: true } : { supported: false, reason: "no-adapter" };
  } catch {
    return { supported: false, reason: "request-failed" };
  }
}
