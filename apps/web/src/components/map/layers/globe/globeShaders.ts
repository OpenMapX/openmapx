/**
 * GLSL for the globe's sky. Everything is computed in MapLibre's globe frame,
 * where the planet is the unit sphere.
 */

export const SKY_VERTEX = `#version 300 es
precision highp float;
uniform mat4 u_inverse;
out vec3 v_near;
out vec3 v_far;
void main() {
  // A full-screen triangle. Each corner unprojects to the near and far planes;
  // both stay planar, so interpolating them per pixel gives that pixel's ray.
  vec2 clip = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vec4 near = u_inverse * vec4(clip, -1.0, 1.0);
  vec4 far = u_inverse * vec4(clip, 1.0, 1.0);
  v_near = near.xyz / near.w;
  v_far = far.xyz / far.w;
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

export const SKY_FRAGMENT = `#version 300 es
precision highp float;
in vec3 v_near;
in vec3 v_far;
uniform vec3 u_sun;
uniform mat3 u_galactic;
uniform float u_lighting;
uniform float u_space;
uniform float u_surface;
uniform vec3 u_theme_sky;
uniform float u_night;
uniform float u_day_falloff;
uniform float u_lights;
uniform float u_galaxy;
uniform sampler2D u_night_lights;
uniform sampler2D u_milky_way;
out vec4 fragColor;

const float PI = 3.14159265359;
const vec3 ATMOSPHERE_BLUE = vec3(0.30, 0.58, 1.0);
const vec3 TWILIGHT = vec3(1.0, 0.45, 0.17);

// Equirectangular lookup without a mipmap seam where longitude wraps: take the
// screen-space derivative from whichever of two offset parameterisations is
// continuous at this pixel.
vec4 sampleWrapped(sampler2D image, vec2 uv) {
  vec2 shifted = vec2(fract(uv.x + 0.5), uv.y);
  vec2 dx = dFdx(uv);
  vec2 dy = dFdy(uv);
  vec2 shiftedDx = dFdx(shifted);
  vec2 shiftedDy = dFdy(shifted);
  if (abs(shiftedDx.x) < abs(dx.x)) dx.x = shiftedDx.x;
  if (abs(shiftedDy.x) < abs(dy.x)) dy.x = shiftedDy.x;
  return textureGrad(image, uv, dx, dy);
}

// Longitude −180° at the left edge, north at the top.
vec2 earthUv(vec3 p) {
  return vec2(atan(p.x, p.z) / (2.0 * PI) + 0.5, 0.5 - asin(clamp(p.y, -1.0, 1.0)) / PI);
}

// Galactic longitude 0 in the middle, increasing to the left, galactic north at the top.
vec2 galacticUv(vec3 g) {
  return vec2(0.5 - atan(g.y, g.x) / (2.0 * PI), 0.5 - asin(clamp(g.z, -1.0, 1.0)) / PI);
}

vec3 sunGlow(vec3 ray) {
  float angle = atan(length(cross(ray, u_sun)), dot(ray, u_sun));
  // The disc's true radius is 0.27°; the corona and halo carry the brightness.
  float disc = 1.0 - smoothstep(0.0042, 0.0056, angle);
  float corona = exp(-angle / 0.018) * 0.65;
  float halo = exp(-pow(angle / 0.09, 1.3)) * 0.2;
  return vec3(1.0, 0.97, 0.88) * disc + vec3(1.0, 0.64, 0.28) * corona + vec3(1.0, 0.5, 0.16) * halo;
}

void main() {
  vec3 origin = v_near;
  vec3 ray = normalize(v_far - v_near);
  float along = -dot(origin, ray);
  vec3 closest = along > 0.0 ? origin + ray * along : origin;
  float r = length(closest);
  float pixel = max(fwidth(r), 1e-6);
  float outside = smoothstep(-pixel, pixel, r - 1.0);
  vec3 limb = closest / max(r, 1e-6);

  // Sunlit side of the limb, and the warm band where the limb meets the terminator.
  float limbSun = dot(limb, u_sun);
  float sunSide = mix(1.0, 0.15 + 0.85 * smoothstep(-0.25, 0.25, limbSun), u_lighting);
  float limbTwilight = exp(-pow(limbSun / 0.14, 2.0)) * u_lighting;
  vec3 glowColour = mix(ATMOSPHERE_BLUE, TWILIGHT, limbTwilight * 0.55);

  // Space: the theme's sky fading into deep space, the Milky Way, the Sun and
  // the atmosphere seen edge-on around the planet.
  float above = max(r - 1.0, 0.0);
  float haze = exp(-above / 0.035) * 0.65;
  float rim = exp(-above / 0.006) * 0.45;
  vec3 space = vec3(0.004, 0.006, 0.012);
  if (u_galaxy * u_space > 0.0) {
    vec3 galaxy = sampleWrapped(u_milky_way, galacticUv(u_galactic * ray)).rgb;
    space += pow(max(galaxy - 0.035, vec3(0.0)), vec3(1.4)) * 0.6 * u_galaxy;
  }
  // Zooming in, the theme's sky rises from the horizon as space recedes
  // upwards, as it does seen from a descending spacecraft. Fully space at u_space = 1.
  float spaceWeight = clamp(2.0 * u_space - exp(-above / 0.08), 0.0, 1.0);
  vec3 background = mix(u_theme_sky, space, spaceWeight);
  background += (glowColour * haze + vec3(0.72, 0.86, 1.0) * rim) * sunSide * u_surface;
  background += sunGlow(ray) * u_lighting * u_surface;

  // The surface under this pixel, lit by the Sun.
  float halfChord = sqrt(max(0.0, 1.0 - r * r));
  vec3 surface = normalize(origin + ray * (along - halfChord));
  float mu = dot(surface, u_sun);
  float day = smoothstep(-0.10, 0.12, mu);
  // Imagery dims towards the terminator like real daylight; maps stay evenly
  // lit across the whole day side so they remain legible.
  float daylight = mix(1.0, 0.75 + 0.25 * sqrt(max(mu, 0.0)), u_day_falloff);
  float brightness = u_night + (1.0 - u_night) * day * daylight;
  brightness = mix(1.0, brightness, u_lighting);

  // Premultiplied layers over the rendered map: night shade, twilight tint,
  // limb haze, then city lights as emitted light.
  vec3 colour = vec3(0.0);
  float alpha = 1.0 - brightness;
  // A warm band at the terminator reads as sunset on imagery, but as a
  // muddy stain on a cartographic map.
  float tint = exp(-pow(mu / 0.045, 2.0)) * u_lighting * u_day_falloff * 0.05;
  colour = TWILIGHT * tint + colour * (1.0 - tint);
  alpha = tint + alpha * (1.0 - tint);
  float limbHaze = exp(-5.0 * halfChord) * 0.5 * mix(1.0, 0.2 + 0.8 * smoothstep(-0.2, 0.3, mu), u_lighting);
  colour = glowColour * limbHaze + colour * (1.0 - limbHaze);
  alpha = limbHaze + alpha * (1.0 - limbHaze);
  if (u_lights > 0.0) {
    float radiance = sampleWrapped(u_night_lights, earthUv(surface)).r;
    float lights = pow(max(radiance - 0.03, 0.0), 1.2);
    float nightSide = 1.0 - smoothstep(-0.12, 0.03, mu);
    vec3 city = mix(vec3(1.0, 0.55, 0.18), vec3(1.0, 0.9, 0.65), smoothstep(0.25, 0.8, lights));
    colour += city * lights * nightSide * 1.6 * u_lights;
  }

  fragColor = mix(vec4(colour, alpha) * u_surface, vec4(background, 1.0), outside);
}`;

export const STAR_VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_direction;
layout(location = 1) in vec3 a_appearance;
uniform mat3 u_matrix;
uniform mat3 u_to_globe;
uniform vec3 u_camera;
uniform float u_pixel_ratio;
out float v_alpha;
out vec3 v_colour;
void main() {
  vec3 direction = u_to_globe * a_direction;
  // Hide stars behind the Earth, and let them fade into the atmosphere's glow.
  float along = -dot(u_camera, direction);
  float missDistance = along > 0.0 ? length(u_camera + direction * along) : 2.0;
  vec3 projected = u_matrix * direction;
  bool visible = missDistance > 1.0 && projected.z > 0.0;
  gl_Position = visible ? vec4(projected.xy, 0.0, projected.z) : vec4(2.0, 2.0, 2.0, 1.0);
  gl_PointSize = a_appearance.x * u_pixel_ratio;
  v_alpha = a_appearance.y * smoothstep(1.0, 1.12, missDistance);
  v_colour = mix(vec3(0.72, 0.83, 1.0), vec3(1.0, 0.9, 0.75), a_appearance.z);
}`;

export const STAR_FRAGMENT = `#version 300 es
precision highp float;
uniform float u_opacity;
in float v_alpha;
in vec3 v_colour;
out vec4 fragColor;
void main() {
  float radius = length(gl_PointCoord * 2.0 - 1.0);
  float alpha = (1.0 - smoothstep(0.0, 1.0, radius)) * v_alpha * u_opacity;
  fragColor = vec4(v_colour * alpha, alpha);
}`;
