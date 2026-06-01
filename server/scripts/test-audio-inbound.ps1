param(
  [string]$BaseUrl    = "http://localhost:3001",
  [string]$Phone      = "5511966665555",
  [string]$SenderName = "Cliente Audio Inbound",
  [string]$AudioUrl   = "",
  [string]$Email      = "mayra@loja.com",
  [string]$Password   = "mudar123"
)

# =====================================================================
# Teste do fluxo de AUDIO RECEBIDO (cliente -> Maryland)
# ---------------------------------------------------------------------
# Simula o cliente enviando um audio pelo WhatsApp (payload Z-API).
# - Se a transcricao (STT) estiver configurada, a Maryland transcreve
#   e responde com base no que foi dito.
# - Se NAO estiver configurada, a Maryland responde pedindo o texto.
#
# Uso: npm run test:audio-in --workspace server
#      ...-File scripts/test-audio-inbound.ps1 -AudioUrl "https://.../voz.ogg"
# =====================================================================

$ErrorActionPreference = "Continue"
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    [ok] $m" -ForegroundColor Green }
function Info($m) { Write-Host "    $m" -ForegroundColor DarkGray }
function Fail($m) { Write-Host "    [erro] $m" -ForegroundColor Red }

$tmp = Join-Path $env:TEMP "maryland-audio-test"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

# Se nenhuma URL de audio for passada, usamos o ultimo audio cadastrado como
# uma URL publica qualquer (so para popular o campo; sem STT a transcricao falha
# de proposito e cai no fallback).
if (-not $AudioUrl) {
  $AudioUrl = "$BaseUrl/uploads/audios/inexistente-demo.ogg"
}

Step "Status de transcricao no servidor"
$health = & curl.exe -s "$BaseUrl/health" | ConvertFrom-Json
Info ("anthropic={0} | transcription(STT)={1}" -f $health.anthropic, $health.transcription)
if (-not $health.transcription) {
  Info "STT desativado: o teste valida o fallback (Maryland pede texto)."
}

Step "Simulando AUDIO recebido do cliente ($Phone)"
$hookFile = Join-Path $tmp "webhook-audio-in.json"
@{
  phone      = $Phone
  fromMe     = $false
  messageId  = "AUDIOIN-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
  senderName = $SenderName
  audio      = @{ audioUrl = $AudioUrl; mimeType = "audio/ogg; codecs=opus" }
} | ConvertTo-Json -Depth 5 | Set-Content -Path $hookFile -Encoding UTF8
$hook = & curl.exe -s -X POST "$BaseUrl/webhook/whatsapp" -H "Content-Type: application/json" --data "@$hookFile" | ConvertFrom-Json
Ok "Webhook respondeu: $($hook | ConvertTo-Json -Compress)"

Step "Verificando a conversa"
$login = @{ email = $Email; password = $Password } | ConvertTo-Json
$loginFile = Join-Path $tmp "login.json"; $login | Set-Content -Path $loginFile -Encoding UTF8
$token = (& curl.exe -s -X POST "$BaseUrl/api/auth/login" -H "Content-Type: application/json" --data "@$loginFile" | ConvertFrom-Json).token

# O download + transcricao leva alguns segundos: faz polling ate a mensagem
# de audio do cliente aparecer (ou ate o timeout).
$messages = @()
for ($i = 0; $i -lt 12; $i++) {
  Start-Sleep -Seconds 2
  $conv = (& curl.exe -s "$BaseUrl/api/conversations" -H "Authorization: Bearer $token" | ConvertFrom-Json).conversations |
    Where-Object { $_.client_phone -eq $Phone } | Select-Object -First 1
  if ($conv) {
    $messages = (& curl.exe -s "$BaseUrl/api/conversations/$($conv.id)" -H "Authorization: Bearer $token" | ConvertFrom-Json).messages
    # Espera ate haver uma resposta (outbound), nao so a mensagem do cliente.
    if (($messages | Where-Object { $_.direction -eq "outbound" }).Count -gt 0) { break }
  }
  Info "aguardando processamento... ($(($i + 1) * 2)s)"
}
if (-not $conv) { Fail "Conversa nao encontrada."; exit 1 }
Write-Host "`n--- Timeline ---" -ForegroundColor Yellow
foreach ($m in $messages) {
  $dir = if ($m.direction -eq "inbound") { "CLIENTE  " } else { "MARYLAND " }
  $color = if ($m.direction -eq "inbound") { "White" } else { "Magenta" }
  Write-Host ("  {0}({1}) {2}" -f $dir, $m.type, $m.content) -ForegroundColor $color
}

Write-Host ""
$audioIn = $messages | Where-Object { $_.direction -eq "inbound" -and $_.type -eq "audio" } | Select-Object -Last 1
$reply = $messages | Where-Object { $_.direction -eq "outbound" } | Select-Object -Last 1

if ($audioIn -and $audioIn.content -and $audioIn.content -ne "[áudio]") {
  Ok "TRANSCRICAO OK: o audio do cliente foi convertido em texto."
  Info "Transcrito: $($audioIn.content)"
} elseif ($audioIn) {
  Fail "O audio chegou mas nao foi transcrito (STT desativado ou falhou)."
}

if ($reply) {
  Ok "A Maryland RESPONDEU ao audio do cliente."
  Info "Resposta: $($reply.content)"
} else {
  Fail "Sem resposta automatica (provavelmente faltam creditos na Anthropic)."
}
