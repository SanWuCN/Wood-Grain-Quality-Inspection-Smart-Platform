#!/usr/bin/env python3
"""Local BLE collector. Only connects to an explicitly bound device; no cloud/phone."""
import argparse, asyncio, json, os, struct, sys, time, uuid
from urllib.request import Request, urlopen
from urllib.error import HTTPError


def emit(state, message, **details):
    print(json.dumps(dict(state=state, message=message, **details)), flush=True)


def ti(value):
    return f'f000{value}-0451-4000-b000-000000000000'


def decode(key, data):
    if key == 'motion':
        if len(data) != 18:
            raise ValueError('Movement 数据应为 18 字节，请确认固件协议')
        v = struct.unpack('<9h', data)
        return dict(gyro=[n*500/65536 for n in v[:3]], accel=[n*16/65536 for n in v[3:6]], mag=[n*4912/32768 for n in v[6:]])
    if key == 'temperature':
        obj, ambient = struct.unpack('<hh', data)
        return dict(objectTemp=(obj >> 2)*.03125, ambientTemp=(ambient >> 2)*.03125)
    if key == 'humidity':
        temp, humidity = struct.unpack('<HH', data)
        return dict(humidityTemp=temp*165/65536-40, humidity=(humidity & ~3)*100/65536)
    if key == 'pressure':
        if len(data) != 6:
            raise ValueError('Pressure 数据应为 6 字节')
        return dict(pressure=int.from_bytes(data[3:6], 'little')/100)
    if key == 'light':
        value, = struct.unpack('<H', data)
        return dict(light=(value & 0xfff)*.01*2**(value >> 12))
    if key == 'battery':
        return dict(battery=data[0])
    return dict(keys=data[0])


# Movement requests 50 Hz. The firmware may clamp this; UI reports measured cadence.
PROFILES = [('motion','aa80','aa81','aa82','aa83',b'\x7f\x02',2),
            ('temperature','aa00','aa01','aa02','aa03',b'\x01',100),
            ('humidity','aa20','aa21','aa22','aa23',b'\x01',100),
            ('pressure','aa40','aa41','aa42','aa44',b'\x01',100),
            ('light','aa70','aa71','aa72','aa73',b'\x01',100)]


def post(url, body):
    token = os.environ.get('MUMAI_SENSOR_TOKEN', '')
    request = Request(url+'/api/sensors/frames', json.dumps(body).encode(),
                      {'Content-Type':'application/json', 'Authorization':'Bearer '+token})
    with urlopen(request, timeout=3) as response:
        return response.status


async def run(args):
    try:
        from bleak import BleakClient, BleakScanner
    except ImportError:
        emit('error','缺少 Bleak。请先安装 tools/sensortag/requirements.txt，并配置 MUMAI_BLE_PYTHON。', code='BLE_DEPENDENCY_MISSING')
        return 2
    if args.scan:
        try:
            discovered = await BleakScanner.discover(timeout=6, return_adv=True)
            emit('idle','扫描完成', devices=[dict(deviceId=d.address,name=d.name or a.local_name or '未命名设备',rssi=a.rssi)
                                          for d,a in discovered.values()])
            return 0
        except Exception as error:
            emit('error',f'蓝牙扫描失败：{error}',code='BLE_SCAN_FAILED')
            return 1
    if not args.device or not os.environ.get('MUMAI_SENSOR_TOKEN'):
        emit('error','缺少绑定设备或 MUMAI_SENSOR_TOKEN',code='BLE_CONFIG_MISSING')
        return 2
    retry = 0
    while True:
        worker = None
        pollers = []
        try:
            emit('connecting' if retry == 0 else 'reconnecting','正在查找已绑定设备',deviceId=args.device)
            device = await BleakScanner.find_device_by_address(args.device, timeout=8)
            if device is None:
                raise RuntimeError('未找到已绑定设备；请开机并退出手机 SensorTag App')
            disconnected = asyncio.Event()
            async with BleakClient(device, disconnected_callback=lambda _: disconnected.set()) as client:
                stream_id = str(uuid.uuid4())
                pending = {}
                ready = asyncio.Event()
                seq = 0
                metadata = dict(deviceName=device.name or 'SensorTag',model='',firmware='')
                for name, char in [('model','00002a24-0000-1000-8000-00805f9b34fb'),('firmware','00002a26-0000-1000-8000-00805f9b34fb')]:
                    try:
                        metadata[name] = bytes(await client.read_gatt_char(char)).decode(errors='replace').strip('\x00')
                    except Exception:
                        pass
                def callback(key):
                    def receive(_, data):
                        try:
                            pending.update(decode(key,data))
                            ready.set()
                        except Exception as error:
                            emit('error',f'{key} 解析失败：{error}',code='BLE_DECODE_FAILED')
                    return receive
                async def sender():
                    nonlocal seq
                    while True:
                        await ready.wait()
                        ready.clear()
                        values = dict(pending)
                        pending.clear()
                        seq += 1
                        body = dict(sessionId=args.session,batchId=args.batch,deviceId=args.device,streamId=stream_id,
                                    seq=seq,sampledAt=time.time()*1000,readings=values,**metadata)
                        try:
                            await asyncio.to_thread(post,args.api,body)
                        except HTTPError as error:
                            # Never log request headers or the collector token.
                            emit('error',f'平台拒绝数据 HTTP {error.code}；请检查权限、批次和时钟',code='PLATFORM_REJECTED')
                        except Exception:
                            emit('error','平台连接失败，恢复后自动发送新数据',code='PLATFORM_UNREACHABLE')
                async def poll(char, key):
                    while client.is_connected:
                        callback(key)(char,await client.read_gatt_char(char))
                        await asyncio.sleep(1)
                worker = asyncio.create_task(sender())
                active = []
                missing = []
                warnings = []
                profile_info = {}
                for key,service,data,config,period,enable,interval in PROFILES:
                    characteristic = client.services.get_characteristic(ti(data))
                    if characteristic is None:
                        missing.append(key)
                        continue
                    try:
                        await client.write_gatt_char(ti(config),enable,response=True)
                        if client.services.get_characteristic(ti(period)):
                            try:
                                await client.write_gatt_char(ti(period),bytes([interval]),response=True)
                            except Exception:
                                # SensorTag 1.20 rejects fast periods. Keep the sensor usable.
                                try:
                                    await client.write_gatt_char(ti(period),bytes([10 if key=='motion' else 100]),response=True)
                                    warnings.append(f'{key}: 固件采用兼容采样周期')
                                except Exception:
                                    warnings.append(f'{key}: 保留固件默认采样周期')
                        try:
                            profile_info[key] = {'config': bytes(await client.read_gatt_char(ti(config))).hex(), 'period': bytes(await client.read_gatt_char(ti(period))).hex()}
                        except Exception:
                            pass
                        if profile_info.get(key,{}).get('config') == 'ff':
                            warnings.append(f'{key}: 固件报告传感器错误（配置 0xff），无有效读数')
                            continue
                        if 'notify' in characteristic.properties:
                            await client.start_notify(characteristic,callback(key))
                        else:
                            pollers.append(asyncio.create_task(poll(characteristic,key)))
                        active.append(key)
                    except Exception as error:
                        warnings.append(f'{key}: {error}')
                        emit('error',f'{key} 订阅失败：{error}',code='BLE_SUBSCRIBE_FAILED')
                for key,char in [('battery','00002a19-0000-1000-8000-00805f9b34fb'),('keys','0000ffe1-0000-1000-8000-00805f9b34fb')]:
                    characteristic = client.services.get_characteristic(char)
                    if characteristic:
                        try:
                            if 'read' in characteristic.properties:
                                callback(key)(char,await client.read_gatt_char(characteristic))
                            if 'notify' in characteristic.properties:
                                await client.start_notify(characteristic,callback(key))
                            elif 'read' in characteristic.properties:
                                pollers.append(asyncio.create_task(poll(characteristic,key)))
                        except Exception:
                            pass
                if not active:
                    raise RuntimeError('未发现兼容 SensorTag 2 服务，请确认型号和固件')
                emit('online','BLE 已连接；订阅 '+', '.join(active)+(('; 未提供 '+', '.join(missing)) if missing else ''),warnings=warnings,profiles=profile_info,code='BLE_ONLINE',**metadata)
                retry = 0
                await disconnected.wait()
                emit('reconnecting','BLE 已断开，正在自动重连',code='BLE_DISCONNECTED')
        except Exception as error:
            emit('reconnecting',str(error),code='BLE_CONNECT_FAILED')
        finally:
            for task in [worker,*pollers]:
                if task:
                    task.cancel()
            await asyncio.gather(*[t for t in [worker,*pollers] if t],return_exceptions=True)
        await asyncio.sleep(min(10,2**retry))
        retry = min(retry+1,4)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--scan',action='store_true')
    parser.add_argument('--device')
    parser.add_argument('--api',default='http://127.0.0.1:8000')
    parser.add_argument('--session',default='demo-01')
    parser.add_argument('--batch',default='scan-Z04-001')
    try:
        sys.exit(asyncio.run(run(parser.parse_args())))
    except KeyboardInterrupt:
        pass
