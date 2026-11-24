// Entry vehicle: a short plasma streak from the vehicle's earlier position (tail) to its
// current one (head), drawn as a screen-aligned ribbon of constant pixel width.
// The glow stays below the bloom threshold (1.0): bloom is reserved for the sun and
// the M3 radar pulse.

const HEAD_COLOR = vec3f(1.000, 0.800, 0.580);
const TAIL_COLOR = vec3f(0.900, 0.360, 0.120);
const PEAK_RADIANCE: f32 = 0.85;
const HALF_WIDTH_PX: f32 = 3.4;
// The bright core at the head, as a fraction of the ribbon length.
const HEAD_CORE: f32 = 0.12;

struct EntryUniforms {
  viewProjection: mat4x4f,
  head: vec3f,
  intensity: f32,
  tail: vec3f,
  viewport: vec2f,
};

@group(0) @binding(0) var<uniform> entry: EntryUniforms;

struct VertexOut {
  @builtin(position) clip: vec4f,
  // x: 0 at tail .. 1 at head (extends past 1 for the rounded cap), y: -1..1 across.
  @location(0) ribbon: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOut {
  let along = array<f32, 6>(0.0, 1.0, 1.0, 0.0, 1.0, 0.0);
  let across = array<f32, 6>(-1.0, -1.0, 1.0, -1.0, 1.0, 1.0);
  let headClip = entry.viewProjection * vec4f(entry.head, 1.0);
  let tailClip = entry.viewProjection * vec4f(entry.tail, 1.0);
  let headPx = headClip.xy / headClip.w * entry.viewport * 0.5;
  let tailPx = tailClip.xy / tailClip.w * entry.viewport * 0.5;
  var direction = headPx - tailPx;
  let lengthPx = max(length(direction), 1.0);
  direction = direction / lengthPx;
  let normal = vec2f(-direction.y, direction.x);

  let t = along[vertexIndex];
  let side = across[vertexIndex];
  // Pad both ends by the half-width so the caps can be rounded in the fragment stage.
  let padded = mix(-HALF_WIDTH_PX, lengthPx + HALF_WIDTH_PX, t);
  let px = tailPx + direction * padded + normal * side * HALF_WIDTH_PX;
  let clip = mix(tailClip, headClip, t);
  var out: VertexOut;
  out.clip = vec4f(px / (entry.viewport * 0.5) * clip.w, clip.z, clip.w);
  out.ribbon = vec2f(padded / lengthPx, side);
  return out;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let along = clamp(input.ribbon.x, 0.0, 1.0);
  let across = abs(input.ribbon.y);
  // Tapers to nothing at the tail; soft edges across the ribbon.
  let taper = smoothstep(0.0, 1.0, along);
  let edge = 1.0 - smoothstep(0.35, 1.0, across / max(mix(0.25, 1.0, taper), 1.0e-3));
  let core = smoothstep(1.0 - HEAD_CORE, 1.0, along);
  let color = mix(TAIL_COLOR, HEAD_COLOR, core) * PEAK_RADIANCE;
  let alpha = edge * taper * entry.intensity;
  if (alpha <= 0.001) {
    discard;
  }
  return vec4f(color, alpha);
}
