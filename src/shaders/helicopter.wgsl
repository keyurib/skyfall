// Three SkyFall helicopters as camera-facing silhouettes: a small coaxial rotorcraft
// side view (two blurred rotor discs, mast, top panel, body, splayed legs) drawn as a
// signed distance field. Per the brief they are dark shapes with only a subtle warm
// rim on the sun-facing edge; output stays far below the bloom threshold (1.0), so
// they never glow.

const INSTANCE_COUNT: u32 = 3u;
const BODY_COLOR = vec3f(0.010, 0.009, 0.010);
const RIM_COLOR = vec3f(1.000, 0.560, 0.300);
const RIM_STRENGTH: f32 = 0.22;
// Width of the rim band inside the silhouette edge, in screen pixels. A fixed pixel
// width keeps thin legs and rotor discs dark at any sprite size: only their sun-facing
// edge catches light.
const RIM_WIDTH_PX: f32 = 1.0;
// Rotor discs are motion-blurred, so they are only partly opaque.
const ROTOR_OPACITY: f32 = 0.78;
const TILT_RADIANS: f32 = 0.05;

struct HelicopterUniforms {
  viewProjection: mat4x4f,
  cameraRight: vec3f,
  time: f32,
  cameraUp: vec3f,
  // Sun direction projected onto the screen plane (right, up), normalised.
  lightScreen: vec2f,
  // xyz = world position, w = sprite half-size in world units.
  instances: array<vec4f, 3>,
  // x, y, z = per-instance opacity.
  visibility: vec4f,
};

@group(0) @binding(0) var<uniform> helicopters: HelicopterUniforms;

struct SpriteOut {
  @location(0) color: vec4f,
  // Attachment 1 is the radar glow; a silhouette blocks the pulse behind it.
  @location(1) glow: vec4f,
};

struct VertexOut {
  @builtin(position) clip: vec4f,
  @location(0) sprite: vec2f,
  @location(1) @interpolate(flat) instance: u32,
};

fn corner(index: u32) -> vec2f {
  // Two triangles covering [-1, 1]^2.
  let corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0),
  );
  return corners[index];
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instance: u32) -> VertexOut {
  let data = helicopters.instances[min(instance, INSTANCE_COUNT - 1u)];
  let offset = corner(vertexIndex);
  let world = data.xyz + (helicopters.cameraRight * offset.x + helicopters.cameraUp * offset.y) * data.w;
  var out: VertexOut;
  out.clip = helicopters.viewProjection * vec4f(world, 1.0);
  out.sprite = offset;
  out.instance = instance;
  return out;
}

fn sdBox(p: vec2f, halfSize: vec2f, radius: f32) -> f32 {
  let q = abs(p) - halfSize + vec2f(radius);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

fn sdSegment(p: vec2f, a: vec2f, b: vec2f, thickness: f32) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - thickness;
}

fn sdEllipse(p: vec2f, radii: vec2f) -> f32 {
  // Cheap approximation, accurate enough for thin rotor discs.
  let k = length(p / radii);
  return (k - 1.0) * min(radii.x, radii.y);
}

// Solid airframe: body, mast, top panel, legs.
fn sdAirframe(p: vec2f) -> f32 {
  var d = sdBox(p - vec2f(0.0, -0.20), vec2f(0.22, 0.13), 0.04);
  d = min(d, sdBox(p - vec2f(0.0, 0.14), vec2f(0.025, 0.24), 0.0));
  d = min(d, sdBox(p - vec2f(0.0, 0.52), vec2f(0.20, 0.022), 0.01));
  let mirrored = vec2f(abs(p.x), p.y);
  d = min(d, sdSegment(mirrored, vec2f(0.13, -0.30), vec2f(0.44, -0.64), 0.030));
  d = min(d, sdSegment(mirrored, vec2f(0.05, -0.30), vec2f(0.17, -0.68), 0.028));
  return d;
}

fn sdRotors(p: vec2f) -> f32 {
  let lower = sdEllipse(p - vec2f(0.0, 0.29), vec2f(0.92, 0.05));
  let upper = sdEllipse(p - vec2f(0.0, 0.42), vec2f(0.92, 0.05));
  return min(lower, upper);
}

fn sdHelicopter(p: vec2f) -> f32 {
  return min(sdAirframe(p), sdRotors(p));
}

@fragment
fn fs_main(input: VertexOut) -> SpriteOut {
  let instance = min(input.instance, INSTANCE_COUNT - 1u);
  let visibility = helicopters.visibility[instance];

  // A slight per-instance lean, swaying a little so the three never look stamped.
  let angle = TILT_RADIANS * sin(helicopters.time * 0.7 + f32(instance) * 2.3) + (f32(instance) - 1.0) * 0.06;
  let c = cos(angle);
  let s = sin(angle);
  let p = vec2f(c * input.sprite.x - s * input.sprite.y, s * input.sprite.x + c * input.sprite.y);

  let airframe = sdAirframe(p);
  let rotors = sdRotors(p);
  let d = min(airframe, rotors);
  let aa = max(fwidth(d), 1.0e-4);
  let solid = 1.0 - smoothstep(-aa, aa, airframe);
  let blur = (1.0 - smoothstep(-aa, aa, rotors)) * ROTOR_OPACITY;
  let alpha = max(solid, blur) * visibility;
  if (alpha <= 0.001) {
    discard;
  }

  // Outward edge normal from the airframe SDF gradient; the rim lights only the solid
  // airframe's sun-facing edges. Motion-blurred rotor discs get no rim.
  let e = 0.01;
  let normal = normalize(vec2f(
    sdAirframe(p + vec2f(e, 0.0)) - sdAirframe(p - vec2f(e, 0.0)),
    sdAirframe(p + vec2f(0.0, e)) - sdAirframe(p - vec2f(0.0, e)),
  ) + vec2f(1.0e-6));
  let spritePerPixel = length(fwidth(p));
  let band = (1.0 - smoothstep(0.0, RIM_WIDTH_PX * spritePerPixel, -airframe)) * step(airframe, rotors + aa);
  let facing = saturate(dot(normal, helicopters.lightScreen));
  let color = BODY_COLOR + RIM_COLOR * (RIM_STRENGTH * band * facing);
  return SpriteOut(vec4f(color, alpha), vec4f(0.0, 0.0, 0.0, alpha));
}
