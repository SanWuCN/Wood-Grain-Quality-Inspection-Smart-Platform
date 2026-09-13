/** TI SensorTag 2 BLE profile; units: g, deg/s, µT, °C, %RH, hPa, lx. */
export const tiUuid = (id) => `f000${id.toLowerCase()}-0451-4000-b000-000000000000`;
export const PROFILES = [
  { key: 'motion', service: 'aa80', data: 'aa81', config: 'aa82', period: 'aa83', enable: [0x3f, 0x02], interval: 10 },
  { key: 'temperature', service: 'aa00', data: 'aa01', config: 'aa02', period: 'aa03', enable: [1], interval: 100 },
  { key: 'humidity', service: 'aa20', data: 'aa21', config: 'aa22', period: 'aa23', enable: [1], interval: 100 },
  { key: 'pressure', service: 'aa40', data: 'aa41', config: 'aa42', period: 'aa44', enable: [1], interval: 100 },
  { key: 'light', service: 'aa70', data: 'aa71', config: 'aa72', period: 'aa73', enable: [1], interval: 100 },
];
export function decodeSensor(key, bytes) {
  const d = bytes instanceof DataView ? bytes : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = { motion: 18, temperature: 4, humidity: 4, pressure: 6, light: 2, battery: 1, keys: 1 }[key];
  if (!need || d.byteLength !== need) throw new Error(`${key}: expected ${need} bytes, received ${d.byteLength}`);
  const i16 = (n) => d.getInt16(n, true), u16 = (n) => d.getUint16(n, true);
  if (key === 'motion') return {
    gyro: [0, 2, 4].map((n) => i16(n) * 500 / 65536),
    accel: [6, 8, 10].map((n) => i16(n) * 16 / 65536),
    mag: [12, 14, 16].map((n) => i16(n) * 4912 / 32768),
  };
  if (key === 'temperature') return { objectTemp: (i16(0) >> 2) * .03125, ambientTemp: (i16(2) >> 2) * .03125 };
  if (key === 'humidity') return { humidityTemp: u16(0) * 165 / 65536 - 40, humidity: (u16(2) & ~3) * 100 / 65536 };
  if (key === 'pressure') return { pressure: (d.getUint8(3) + d.getUint8(4) * 256 + d.getUint8(5) * 65536) / 100 };
  if (key === 'light') { const v = u16(0); return { light: (v & 0xfff) * .01 * 2 ** (v >> 12) }; }
  if (key === 'battery') return { battery: d.getUint8(0) };
  return { keys: d.getUint8(0) };
}
export function multiply(a, b) {
  const [x,y,z,w] = a, [X,Y,Z,W] = b;
  return [w*X+x*W+y*Z-z*Y, w*Y-x*Z+y*W+z*X, w*Z+x*Y-y*X+z*W, w*W-x*X-y*Y-z*Z];
}
export const normalize = (q) => { const n = Math.hypot(...q); return n > 1e-9 ? q.map((v) => v/n) : [0,0,0,1]; };
/** Six-axis gravity-corrected quaternion. Heading is relative, never magnetic north. */
export class AttitudeFilter {
  q = [0,0,0,1];
  at = null;
  bias = [0,0,0];
  calibration = 'none';
  samples = [];
  calibrate() { this.samples=[]; this.calibration='collecting'; }
  update(accel, gyro, at) {
    const [ax,ay,az] = accel, length = Math.hypot(...accel);
    if (this.calibration==='collecting') {
      // Explicit operator-requested calibration: legacy units can have large DC bias.
      if (length>.7 && length<1.35 && Math.hypot(...gyro)<35) this.samples.push({gyro:[...gyro],accel:[...accel]});
      else this.samples=[];
      if (this.samples.length>=100) {
        const mean=[0,1,2].map((i)=>this.samples.reduce((sum,s)=>sum+s.gyro[i],0)/this.samples.length);
        const variance=Math.max(...[0,1,2].map((i)=>this.samples.reduce((sum,s)=>sum+(s.gyro[i]-mean[i])**2,0)/this.samples.length));
        const gravity=[0,1,2].map((i)=>this.samples.reduce((sum,s)=>sum+s.accel[i],0)/this.samples.length);
        const accelerationVariance=Math.max(...[0,1,2].map((i)=>this.samples.reduce((sum,s)=>sum+(s.accel[i]-gravity[i])**2,0)/this.samples.length));
        if (variance<4 && accelerationVariance<.005) { this.bias=mean; this.calibration='ready'; }
        this.samples=[];
      }
    }
    if (this.at === null) {
      const roll = Math.atan2(ay,az), pitch = Math.atan2(-ax,Math.hypot(ay,az));
      this.q = multiply([0,Math.sin(pitch/2),0,Math.cos(pitch/2)], [Math.sin(roll/2),0,0,Math.cos(roll/2)]);
      this.at = at;
      return this.q;
    }
    // Missing motion cannot be reconstructed: preserve heading and restart the integration clock.
    if (at-this.at>1000) { this.at=at; return [...this.q]; }
    const dt = Math.max(0,Math.min(.2,(at-this.at)/1000));
    this.at = at;
    const [x,y,z,w] = this.q;
    const omega = gyro.map((v,i) => (v-this.bias[i])*Math.PI/180);
    // Only trust gravity near 1 g; dynamic acceleration must not pull the attitude.
    if (length > .7 && length < 1.35) {
      const vx = 2*(x*z-w*y), vy = 2*(w*x+y*z), vz = w*w-x*x-y*y+z*z;
      omega[0] += 2*(ay/length*vz-az/length*vy);
      omega[1] += 2*(az/length*vx-ax/length*vz);
      omega[2] += 2*(ax/length*vy-ay/length*vx);
    }
    const derivative = multiply(this.q,[...omega,0]);
    this.q = normalize(this.q.map((v,i) => v+derivative[i]*dt/2));
    return this.q;
  }
}

/** Quaternion low-pass: stronger at rest, faster while turning; q and -q are equivalent. */
export class PoseSmoother {
  q = null;
  raw = null;
  at = null;
  speed = 0;
  update(input, at) {
    const target = normalize(input);
    if (!this.q) { this.q=target; this.raw=target; this.at=at; return [...this.q]; }
    const dt = Math.max(.001, Math.min(.2, (at-this.at)/1000));
    const dot = (a,b) => a.reduce((sum,v,i)=>sum+v*b[i],0);
    const angle = (a,b) => 2*Math.acos(Math.min(1,Math.abs(dot(a,b))));
    const velocity = angle(this.raw,target)/dt*180/Math.PI;
    this.speed += (velocity-this.speed)*(1-Math.exp(-2*Math.PI*dt));
    this.raw=target; this.at=at;
    const error = angle(this.q,target);
    // Hold sub-pixel noise, but compare against the held output so slow turns still accumulate.
    if (error < .12*Math.PI/180) return [...this.q];
    const alpha = 1-Math.exp(-2*Math.PI*(.65+.08*this.speed)*dt);
    const sign = dot(this.q,target)<0 ? -1 : 1;
    const half = error/2;
    const a = half<1e-6 ? 1-alpha : Math.sin((1-alpha)*half)/Math.sin(half);
    const b = half<1e-6 ? alpha : Math.sin(alpha*half)/Math.sin(half);
    this.q=normalize(this.q.map((v,i)=>a*v+b*sign*target[i]));
    return [...this.q];
  }
}
