import { AttitudeFilter } from '../../shared/sensortag.mjs';
import { WorkflowError } from './workflow.mjs';

const fail = (message) => { throw new WorkflowError(422, 'BAD_SENSOR_FRAME', message); };
const limits = { ambientTemp: [-100,200], objectTemp: [-100,500], humidityTemp: [-100,200], humidity: [0,100], pressure: [0,2000], light: [0,200000], battery: [0,100], keys: [0,7], rssi: [-150,0] };
export function validateFrame(body) {
  if (!body || typeof body !== 'object') fail('缺少传感器数据');
  if (body.simulated === true || (body.source !== undefined && body.source !== 'ble:sensortag')) fail('真实采集入口不接收模拟数据');
  for (const key of ['batchId','deviceId','streamId']) {
    if (typeof body[key] !== 'string' || !/^[\w.:-]{1,100}$/.test(body[key])) fail(`${key} 无效`);
  }
  if (!Number.isSafeInteger(body.seq) || body.seq < 0) fail('seq 必须为非负整数');
  if (!Number.isFinite(body.sampledAt) || Math.abs(Date.now()-body.sampledAt) > 60000) fail('采样时间与平台偏差超过 60 秒，请同步时钟');
  const input = body.readings;
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('readings 无效');
  const readings = {};
  for (const [key,value] of Object.entries(input)) {
    if (['accel','gyro','mag'].includes(key)) {
      const max = key === 'accel' ? 32 : key === 'gyro' ? 4000 : 10000;
      if (!Array.isArray(value) || value.length !== 3 || value.some((v) => !Number.isFinite(v) || Math.abs(v)>max)) fail(`${key} 必须为有效的三轴读数`);
    } else {
      if (!limits[key]) fail(`不支持的读数字段 ${key}`);
      if (!Number.isFinite(value) || value < limits[key][0] || value > limits[key][1]) fail(`${key} 超出有效范围`);
    }
    readings[key] = value;
  }
  if (!Object.keys(readings).length) fail('readings 不能为空');
  if (Boolean(readings.accel) !== Boolean(readings.gyro)) fail('加速度与陀螺仪必须同帧上报');
  return { batchId: body.batchId, deviceId: body.deviceId, streamId: body.streamId, seq: body.seq, sampledAt: body.sampledAt, readings,
    deviceName: String(body.deviceName ?? 'SensorTag').slice(0,100), model: String(body.model ?? '').slice(0,100), firmware: String(body.firmware ?? '').slice(0,100) };
}
export function createSensorService(db, hub) {
  db.exec(`CREATE TABLE IF NOT EXISTS sensor_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sensor_calibration_events (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, config TEXT NOT NULL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS sensor_frames (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, batch_id TEXT NOT NULL, device_id TEXT NOT NULL, stream_id TEXT NOT NULL, seq INTEGER NOT NULL, sampled_at REAL NOT NULL, frame TEXT NOT NULL, UNIQUE(session_id,batch_id,device_id,stream_id,seq));
    CREATE INDEX IF NOT EXISTS sensor_lookup ON sensor_frames(session_id,batch_id,device_id,id);`);
  const states = new Map();
  const calibrationFor = (deviceId) => JSON.parse(db.prepare("SELECT value FROM sensor_settings WHERE key=?").get(`calibration:${deviceId}`)?.value ?? 'null');
  let cleanedAt = 0;
  return {
    calibrateGyro(sessionId,batchId,deviceId) {
      const state=states.get(JSON.stringify([sessionId,batchId,deviceId]));
      if (!state || !state.frame.poseAt || Date.now()-state.frame.poseAt>3000) throw new WorkflowError(409,'SENSOR_OFFLINE','请先接收实时姿态数据');
      state.filter.calibrate();
      return { state:'collecting', message:'请静置扫描枪，等待 100 个稳定采样完成零偏校准' };
    },
    calibration: calibrationFor,
    calibrate(deviceId, body, actor) {
      if (!/^[\w.:-]{1,100}$/.test(deviceId)) fail('设备标识无效');
      const { temperatureOffset, lightScale, lightOffset, reason } = body;
      if (!Number.isFinite(temperatureOffset) || Math.abs(temperatureOffset)>20 || !Number.isFinite(lightScale) || lightScale<=0 || lightScale>10 || !Number.isFinite(lightOffset) || Math.abs(lightOffset)>10000 || typeof reason!=='string' || reason.trim().length<3 || reason.length>500) fail('请填写有效的温度偏移、光照系数与校准依据');
      const config = { temperatureOffset, lightScale, lightOffset, reason:reason.trim(), actor, at:Date.now() };
      db.prepare('INSERT OR REPLACE INTO sensor_settings(key,value) VALUES(?,?)').run(`calibration:${deviceId}`,JSON.stringify(config));
      db.prepare('INSERT INTO sensor_calibration_events(device_id,config) VALUES(?,?)').run(deviceId,JSON.stringify(config));
      return config;
    },
    ingest(sessionId, body) {
      const input = validateFrame(body);
      const key = JSON.stringify([sessionId,input.batchId,input.deviceId]);
      let state = states.get(key);
      const prior = state?.frame ?? JSON.parse(db.prepare('SELECT frame FROM sensor_frames WHERE session_id=? AND batch_id=? AND device_id=? ORDER BY id DESC LIMIT 1').get(sessionId,input.batchId,input.deviceId)?.frame ?? 'null');
      if (prior && (input.sampledAt <= prior.sampledAt || (input.streamId === prior.streamId && input.seq <= prior.seq))) {
        throw new WorkflowError(409,'OLD_SENSOR_FRAME','重复或乱序的传感器帧');
      }
      if (!state || state.frame.streamId !== input.streamId || input.sampledAt-state.frame.sampledAt > 1000) {
        state = { filter: new AttitudeFilter(), frame: null };
        const savedBias=JSON.parse(db.prepare('SELECT value FROM sensor_settings WHERE key=?').get(`gyro:${input.deviceId}`)?.value ?? 'null');
        if (savedBias && Array.isArray(savedBias.bias) && savedBias.bias.length===3 && savedBias.bias.every(Number.isFinite)) {
          state.filter.bias=savedBias.bias;
          state.filter.calibration='ready';
        }
      }
      const receivedAt = Date.now();
      const previous = state.frame;
      const readings = { ...previous?.readings, ...input.readings };
      const fieldAt = { ...previous?.fieldAt };
      for (const field of Object.keys(input.readings)) fieldAt[field] = receivedAt;
      const motion = input.readings.accel && input.readings.gyro;
      const wasCalibrating=state.filter.calibration==='collecting';
      const quaternion = motion ? state.filter.update(input.readings.accel,input.readings.gyro,input.sampledAt) : previous?.quaternion ?? null;
      if (wasCalibrating && state.filter.calibration==='ready') {
        const record={bias:state.filter.bias,at:receivedAt,method:'100 stationary samples'};
        db.prepare('INSERT OR REPLACE INTO sensor_settings(key,value) VALUES(?,?)').run(`gyro:${input.deviceId}`,JSON.stringify(record));
        db.prepare('INSERT INTO sensor_calibration_events(device_id,config) VALUES(?,?)').run(input.deviceId,JSON.stringify(record));
      }
      const calibration = calibrationFor(input.deviceId);
      const calibrated = {
        ...(typeof readings.ambientTemp==='number' ? { ambientTemp:readings.ambientTemp+(calibration?.temperatureOffset ?? 0) } : {}),
        ...(typeof readings.light==='number' ? { light:Math.max(0,readings.light*(calibration?.lightScale ?? 1)+(calibration?.lightOffset ?? 0)) } : {}),
      };
      const frame = { ...input, sessionId, readings, calibrated, calibration, gyroCalibration:state.filter.calibration, gyroBias:state.filter.bias, fieldAt, receivedAt, quaternion, poseAt: motion ? receivedAt : previous?.poseAt ?? null, source: 'ble:sensortag', simulated:false, heading: 'relative' };
      // Push every frame; persist one raw/calibrated snapshot per second for seven days.
      if (!state.savedAt || receivedAt-state.savedAt>=1000) {
        const result = db.prepare('INSERT INTO sensor_frames(session_id,batch_id,device_id,stream_id,seq,sampled_at,frame) VALUES(?,?,?,?,?,?,?)').run(sessionId,input.batchId,input.deviceId,input.streamId,input.seq,input.sampledAt,JSON.stringify(frame));
        frame.id = Number(result.lastInsertRowid);
        state.savedAt = receivedAt;
      }
      if (receivedAt-cleanedAt>3600000) {
        db.prepare('DELETE FROM sensor_frames WHERE sampled_at<?').run(receivedAt-7*86400000);
        cleanedAt=receivedAt;
      }
      state.frame = frame;
      states.set(key,state);
      if (states.size > 100) states.delete(states.keys().next().value);
      hub.broadcastSensor(sessionId,frame);
      return frame;
    },
    latest(sessionId,batchId,deviceId) {
      const inMemory = [...states.values()].map((s)=>s.frame).filter((f)=>f.sessionId===sessionId&&f.batchId===batchId&&(!deviceId||f.deviceId===deviceId)).sort((a,b)=>b.receivedAt-a.receivedAt)[0];
      if (inMemory) return inMemory;
      const rows = db.prepare('SELECT id,frame FROM sensor_frames WHERE session_id=? AND batch_id=? AND (? IS NULL OR device_id=?) ORDER BY id DESC LIMIT 1').get(sessionId,batchId,deviceId,deviceId);
      return rows ? { ...JSON.parse(rows.frame), id: rows.id } : null;
    },
    history(sessionId,batchId,deviceId,after=0,from=0) {
      return db.prepare('SELECT id,frame FROM sensor_frames WHERE session_id=? AND batch_id=? AND (? IS NULL OR device_id=?) AND id>? AND sampled_at>=? ORDER BY id LIMIT 1000').all(sessionId,batchId,deviceId,deviceId,after,from).map((r)=>({...JSON.parse(r.frame),id:r.id}));
    },
  };
}
