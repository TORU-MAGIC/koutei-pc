[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 8080,

    [string]$BindAddress = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
$projectRootWithSeparator = $projectRoot + [System.IO.Path]::DirectorySeparatorChar
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$headerEncoding = [System.Text.Encoding]::ASCII
$accessToken = [System.Guid]::NewGuid().ToString("N").Substring(0, 8)

$publicFiles = @{
    "soundpad.html" = "soundpad.html"
    "soundpad.css" = "soundpad.css"
    "soundpad.js" = "soundpad.js"
    "sound-effects/sfx_correct_pingpong.wav" = "sound-effects\sfx_correct_pingpong.wav"
    "sound-effects/sfx_wrong_buzzer.wav" = "sound-effects\sfx_wrong_buzzer.wav"
    "sound-effects/sfx_magic_sparkle_reveal.wav" = "sound-effects\sfx_magic_sparkle_reveal.wav"
    "sound-effects/sfx_magic_whoosh_appear.wav" = "sound-effects\sfx_magic_whoosh_appear.wav"
    "sound-effects/sfx_magic_vanish_poof.wav" = "sound-effects\sfx_magic_vanish_poof.wav"
    "sound-effects/sfx_magic_tada_sting.wav" = "sound-effects\sfx_magic_tada_sting.wav"
}

function Get-LanBinding {
    param([string]$RequestedAddress)

    if (-not [string]::IsNullOrWhiteSpace($RequestedAddress)) {
        $parsedAddress = $null
        if (-not [System.Net.IPAddress]::TryParse($RequestedAddress, [ref]$parsedAddress) -or
            $parsedAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or
            [System.Net.IPAddress]::IsLoopback($parsedAddress) -or
            $parsedAddress.Equals([System.Net.IPAddress]::Any)) {
            throw "BindAddressには、このPCで使用中のLAN IPv4アドレスを指定してください。"
        }
        $ipEntry = Get-NetIPAddress -AddressFamily IPv4 -IPAddress $parsedAddress.ToString() -ErrorAction Stop |
            Select-Object -First 1
        return [pscustomobject]@{
            Address = $parsedAddress
            PrefixLength = [int]$ipEntry.PrefixLength
            InterfaceAlias = [string]$ipEntry.InterfaceAlias
        }
    }

    $routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "0.0.0.0/0" -ErrorAction Stop |
        Where-Object { $_.State -eq "Alive" } |
        Sort-Object -Property RouteMetric, InterfaceMetric)

    foreach ($route in $routes) {
        $ipEntries = @(Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue |
            Where-Object {
                $_.IPAddress -notlike "127.*" -and
                $_.IPAddress -notlike "169.254.*" -and
                $_.AddressState -ne "Tentative"
            })
        foreach ($ipEntry in $ipEntries) {
            return [pscustomobject]@{
                Address = [System.Net.IPAddress]::Parse($ipEntry.IPAddress)
                PrefixLength = [int]$ipEntry.PrefixLength
                InterfaceAlias = [string]$ipEntry.InterfaceAlias
            }
        }
    }

    throw "利用可能なLAN IPv4アドレスを検出できませんでした。"
}

function Test-SameSubnet {
    param(
        [Parameter(Mandatory = $true)][System.Net.IPAddress]$First,
        [Parameter(Mandatory = $true)][System.Net.IPAddress]$Second,
        [Parameter(Mandatory = $true)][ValidateRange(0, 32)][int]$PrefixLength
    )

    if ($First.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or
        $Second.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
        return $false
    }

    $firstBytes = $First.GetAddressBytes()
    $secondBytes = $Second.GetAddressBytes()
    $fullBytes = [math]::Floor($PrefixLength / 8)
    $remainingBits = $PrefixLength % 8

    for ($index = 0; $index -lt $fullBytes; $index++) {
        if ($firstBytes[$index] -ne $secondBytes[$index]) {
            return $false
        }
    }

    if ($remainingBits -gt 0) {
        $mask = (0xFF -shl (8 - $remainingBits)) -band 0xFF
        if (($firstBytes[$fullBytes] -band $mask) -ne ($secondBytes[$fullBytes] -band $mask)) {
            return $false
        }
    }
    return $true
}

function Get-ContentType {
    param([Parameter(Mandatory = $true)][string]$Path)

    switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
        ".html" { return "text/html; charset=utf-8" }
        ".css"  { return "text/css; charset=utf-8" }
        ".js"   { return "application/javascript; charset=utf-8" }
        ".wav"  { return "audio/wav" }
        default  { return "application/octet-stream" }
    }
}

function Send-Response {
    param(
        [Parameter(Mandatory = $true)][System.IO.Stream]$Stream,
        [Parameter(Mandatory = $true)][int]$StatusCode,
        [Parameter(Mandatory = $true)][string]$Reason,
        [Parameter(Mandatory = $true)][string]$ContentType,
        [byte[]]$Body = [byte[]]@(),
        [bool]$IncludeBody = $true
    )

    $headerText = "HTTP/1.1 $StatusCode $Reason`r`n" +
        "Content-Type: $ContentType`r`n" +
        "Content-Length: $($Body.Length)`r`n" +
        "Cache-Control: no-store, no-cache, must-revalidate, max-age=0`r`n" +
        "Pragma: no-cache`r`n" +
        "Expires: 0`r`n" +
        "Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`r`n" +
        "Cross-Origin-Resource-Policy: same-origin`r`n" +
        "Referrer-Policy: no-referrer`r`n" +
        "X-Content-Type-Options: nosniff`r`n" +
        "X-Frame-Options: DENY`r`n" +
        "Connection: close`r`n`r`n"
    $headerBytes = $headerEncoding.GetBytes($headerText)
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    if ($IncludeBody -and $Body.Length -gt 0) {
        $Stream.Write($Body, 0, $Body.Length)
    }
    $Stream.Flush()
}

function Send-TextResponse {
    param(
        [Parameter(Mandatory = $true)][System.IO.Stream]$Stream,
        [Parameter(Mandatory = $true)][int]$StatusCode,
        [Parameter(Mandatory = $true)][string]$Reason,
        [Parameter(Mandatory = $true)][string]$Message,
        [bool]$IncludeBody = $true
    )

    $body = $utf8NoBom.GetBytes($Message + "`n")
    Send-Response -Stream $Stream -StatusCode $StatusCode -Reason $Reason `
        -ContentType "text/plain; charset=utf-8" -Body $body -IncludeBody $IncludeBody
}

function Test-PathHasReparsePoint {
    param([Parameter(Mandatory = $true)][string]$Path)

    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        return $true
    }

    $directory = if ($item -is [System.IO.DirectoryInfo]) { $item } else { $item.Directory }
    while ($null -ne $directory) {
        if (($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            return $true
        }
        if ($directory.FullName.TrimEnd([System.IO.Path]::DirectorySeparatorChar) -ieq $projectRoot) {
            break
        }
        $directory = $directory.Parent
    }
    return $false
}

function Resolve-PublicFile {
    param([Parameter(Mandatory = $true)][string]$RawTarget)

    if ($RawTarget.Length -gt 2048) {
        throw [System.IO.PathTooLongException]::new("Request target is too long")
    }

    $targetWithoutQuery = $RawTarget.Split([char]'?')[0]
    $decodedPath = [System.Uri]::UnescapeDataString($targetWithoutQuery)
    if (-not $decodedPath.StartsWith("/") -or
        $decodedPath.IndexOf([char]0) -ge 0 -or
        $decodedPath.Contains("\") -or
        $decodedPath.Contains(":")) {
        throw [System.UnauthorizedAccessException]::new("Invalid request path")
    }

    $tokenPrefix = "/" + $accessToken + "/"
    if (-not $decodedPath.StartsWith($tokenPrefix, [System.StringComparison]::Ordinal)) {
        throw [System.UnauthorizedAccessException]::new("Invalid access token")
    }

    $relativePath = $decodedPath.Substring($tokenPrefix.Length)
    if ([string]::IsNullOrWhiteSpace($relativePath)) {
        $relativePath = "soundpad.html"
    }
    if ($relativePath.Split([char]'/') | Where-Object { $_ -eq "." -or $_ -eq ".." }) {
        throw [System.UnauthorizedAccessException]::new("Path traversal is not allowed")
    }

    $publicKey = $relativePath.ToLowerInvariant()
    if (-not $publicFiles.ContainsKey($publicKey)) {
        throw [System.IO.FileNotFoundException]::new("Public file not found")
    }

    $candidate = [System.IO.Path]::GetFullPath(
        [System.IO.Path]::Combine($projectRoot, [string]$publicFiles[$publicKey])
    )
    if (-not $candidate.StartsWith($projectRootWithSeparator, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [System.IO.File]::Exists($candidate) -or
        (Test-PathHasReparsePoint -Path $candidate)) {
        throw [System.UnauthorizedAccessException]::new("Unsafe public file path")
    }

    return [pscustomobject]@{
        FilePath = $candidate
        PublicPath = $publicKey
    }
}

function Handle-Client {
    param(
        [Parameter(Mandatory = $true)][System.Net.Sockets.TcpClient]$Client,
        [Parameter(Mandatory = $true)][System.Net.IPAddress]$LocalAddress,
        [Parameter(Mandatory = $true)][int]$PrefixLength
    )

    $stream = $null
    $reader = $null
    try {
        $remoteAddress = $Client.Client.RemoteEndPoint.Address
        if (-not [System.Net.IPAddress]::IsLoopback($remoteAddress) -and
            -not (Test-SameSubnet -First $LocalAddress -Second $remoteAddress -PrefixLength $PrefixLength)) {
            return
        }

        $Client.ReceiveTimeout = 5000
        $Client.SendTimeout = 5000
        $stream = $Client.GetStream()
        $stream.ReadTimeout = 5000
        $stream.WriteTimeout = 5000
        $reader = New-Object System.IO.StreamReader($stream, $headerEncoding, $false, 1024, $true)

        $requestLine = $reader.ReadLine()
        if ([string]::IsNullOrWhiteSpace($requestLine)) {
            return
        }

        $headerCharacters = $requestLine.Length + 2
        while ($true) {
            $line = $reader.ReadLine()
            if ($null -eq $line -or $line.Length -eq 0) {
                break
            }
            $headerCharacters += $line.Length + 2
            if ($headerCharacters -gt 16384) {
                Send-TextResponse -Stream $stream -StatusCode 431 -Reason "Request Header Fields Too Large" `
                    -Message "Request headers are too large"
                return
            }
        }

        $parts = $requestLine -split '\s+'
        if ($parts.Count -ne 3) {
            Send-TextResponse -Stream $stream -StatusCode 400 -Reason "Bad Request" -Message "Malformed request line"
            return
        }

        $method = $parts[0].ToUpperInvariant()
        $includeBody = $method -ne "HEAD"
        if ($method -ne "GET" -and $method -ne "HEAD") {
            Send-TextResponse -Stream $stream -StatusCode 405 -Reason "Method Not Allowed" `
                -Message "Only GET and HEAD are supported" -IncludeBody $includeBody
            return
        }

        try {
            $resolved = Resolve-PublicFile -RawTarget $parts[1]
            $body = [System.IO.File]::ReadAllBytes($resolved.FilePath)
            Send-Response -Stream $stream -StatusCode 200 -Reason "OK" `
                -ContentType (Get-ContentType -Path $resolved.FilePath) -Body $body -IncludeBody $includeBody
            Write-Host ("{0:HH:mm:ss} {1} {2} {3}" -f (Get-Date), $remoteAddress, $method, $resolved.PublicPath) -ForegroundColor DarkGray
        } catch [System.IO.PathTooLongException] {
            Send-TextResponse -Stream $stream -StatusCode 414 -Reason "URI Too Long" `
                -Message "Request target is too long" -IncludeBody $includeBody
        } catch [System.IO.FileNotFoundException] {
            Send-TextResponse -Stream $stream -StatusCode 404 -Reason "Not Found" `
                -Message "File not found" -IncludeBody $includeBody
        } catch [System.UnauthorizedAccessException] {
            Send-TextResponse -Stream $stream -StatusCode 403 -Reason "Forbidden" `
                -Message "Access denied" -IncludeBody $includeBody
        } catch [System.UriFormatException] {
            Send-TextResponse -Stream $stream -StatusCode 400 -Reason "Bad Request" `
                -Message "Invalid URL encoding" -IncludeBody $includeBody
        }
    } catch {
        Write-Warning ("接続処理エラー: " + $_.Exception.Message)
    } finally {
        if ($null -ne $reader) {
            $reader.Dispose()
        }
        if ($null -ne $stream) {
            $stream.Dispose()
        }
        $Client.Dispose()
    }
}

$binding = Get-LanBinding -RequestedAddress $BindAddress
$listener = [System.Net.Sockets.TcpListener]::new($binding.Address, $Port)
$started = $false

try {
    $listener.Start()
    $started = $true
    $soundpadUrl = "http://{0}:{1}/{2}/" -f $binding.Address, $Port, $accessToken

    Write-Host ""
    Write-Host "Magic Show Cue スマホ効果音パッド" -ForegroundColor Cyan
    Write-Host "--------------------------------------" -ForegroundColor DarkGray
    Write-Host "同じWi-Fiのスマホで、次のURLを開いてください。" -ForegroundColor White
    Write-Host ("  " + $soundpadUrl) -ForegroundColor Green
    Write-Host ""
    Write-Host ("接続先: {0} / {1}" -f $binding.InterfaceAlias, $binding.Address) -ForegroundColor DarkGray
    Write-Host "公開対象: スマホ画面と内蔵効果音6ファイルのみ" -ForegroundColor DarkGray
    Write-Host "URLのアクセスキーは起動するたびに変わります。" -ForegroundColor DarkGray
    Write-Host "停止する時は Ctrl+C を押すか、この画面を閉じます。" -ForegroundColor Yellow
    Write-Host "Windowsの確認が出た場合は、信頼できるプライベートネットワークだけ許可してください。" -ForegroundColor Yellow

    try {
        $profile = Get-NetConnectionProfile -InterfaceAlias $binding.InterfaceAlias -ErrorAction Stop |
            Select-Object -First 1
        if ($profile.NetworkCategory -eq "Public") {
            Write-Warning "現在のネットワークは Public です。信頼できる自宅Wi-Fiの場合だけ、Windows設定で Private に変更してください。"
        }
    } catch {
        Write-Host "ネットワーク種別を確認できませんでした。" -ForegroundColor DarkGray
    }

    Write-Host ""
    while ($true) {
        $client = $listener.AcceptTcpClient()
        Handle-Client -Client $client -LocalAddress $binding.Address -PrefixLength $binding.PrefixLength
    }
} catch {
    Write-Error ("スマホサーバーを起動できませんでした: " + $_.Exception.Message)
    exit 1
} finally {
    if ($started) {
        $listener.Stop()
    }
}
