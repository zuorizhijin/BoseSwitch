# 列出蓝牙设备的 RFCOMM 服务：UUID、服务名、SDP 中的 RFCOMM 通道号
# 用法: powershell -File tools\sdp_rfcomm.ps1 020000004501
param([string]$Mac)

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
function Await($op, [Type]$t) {
    $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op))
    $task.Wait() | Out-Null
    $task.Result
}

$null = [Windows.Devices.Bluetooth.BluetoothDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
$null = [Windows.Devices.Bluetooth.Rfcomm.RfcommDeviceServicesResult, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]

$addr = [Convert]::ToUInt64($Mac.Replace(':', ''), 16)
$dev = Await ([Windows.Devices.Bluetooth.BluetoothDevice]::FromBluetoothAddressAsync($addr)) ([Windows.Devices.Bluetooth.BluetoothDevice])
"device: $($dev.Name)  status: $($dev.ConnectionStatus)"
$res = Await ($dev.GetRfcommServicesAsync([Windows.Devices.Bluetooth.BluetoothCacheMode]::Uncached)) ([Windows.Devices.Bluetooth.Rfcomm.RfcommDeviceServicesResult])
"query error: $($res.Error)  services: $($res.Services.Count)"
foreach ($s in $res.Services) {
    $ch = '?'
    try {
        $attrs = Await ($s.GetSdpRawAttributesAsync([Windows.Devices.Bluetooth.BluetoothCacheMode]::Cached)) ([System.Collections.Generic.IReadOnlyDictionary[UInt32, Windows.Storage.Streams.IBuffer]])
        $buf = $null
        foreach ($kv in $attrs) { if ($kv.Key -eq 4) { $buf = $kv.Value } }
        if ($buf) {
            $r = [Windows.Storage.Streams.DataReader]::FromBuffer($buf)
            $bytes = New-Object byte[] $buf.Length
            $r.ReadBytes($bytes)
            # 在协议描述列表里找 RFCOMM UUID16 0x0003 后面紧跟的 uint8 通道号 (0x08 xx)
            for ($i = 0; $i -lt $bytes.Length - 4; $i++) {
                if ($bytes[$i] -eq 0x19 -and $bytes[$i + 1] -eq 0x00 -and $bytes[$i + 2] -eq 0x03 -and $bytes[$i + 3] -eq 0x08) { $ch = $bytes[$i + 4] }
            }
        }
    } catch { $ch = "err: $($_.Exception.Message)" }
    "  ch=$ch  uuid=$($s.ServiceId.Uuid)  $($s.ConnectionServiceName)"
}
