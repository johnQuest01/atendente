param(
  [string]$BaseUrl        = "http://localhost:3001",
  [string]$Email          = "mayra@loja.com",
  [string]$Password       = "mudar123",
  [string]$Keyword        = "promocao",
  [string]$TriggerMessage = "Oi! Voces tem alguma promocao essa semana no atacado?",
  [string]$Phone          = "5511977776666",
  [string]$SenderName     = "Cliente Teste Audio"
)

# =====================================================================
# Teste END-TO-END do fluxo de AUDIO (loja Maryland)
# ---------------------------------------------------------------------
# 1. Faz login no painel (JWT)
# 2. Gera um audio de teste (tom) com ffmpeg
# 3. CADASTRA o audio via API  -> backend converte p/ .ogg/opus + salva no banco
# 4. VINCULA uma palavra-chave a esse audio
# 5. SIMULA uma mensagem do cliente contendo a palavra-chave
# 6. Verifica que o sistema DEVOLVEU o audio na conversa (mensagem tipo 'audio')
#
# Nao gasta creditos da Anthropic (audio por keyword nao passa pela IA).
# Uso: npm run test:audio --workspace server
# =====================================================================

# Native commands (ffmpeg/curl) escrevem no stderr; nao queremos que isso
# aborte o script. Validamos cada passo manualmente.
$ErrorActionPreference = "Continue"

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    [ok] $m" -ForegroundColor Green }
function Info($m) { Write-Host "    $m" -ForegroundColor DarkGray }
function Fail($m) { Write-Host "    [erro] $m" -ForegroundColor Red }

# --- ffmpeg (binario embarcado pelo @ffmpeg-installer) ---
Step "Localizando ffmpeg"
$ffmpeg = (& node -e "console.log(require('@ffmpeg-installer/ffmpeg').path)").Trim()
Info $ffmpeg

$tmp = Join-Path $env:TEMP "maryland-audio-test"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$wav = Join-Path $tmp "teste-tom.wav"

# --- 1) gerar audio de teste ---
Step "Gerando audio de teste (tom senoidal de 3s)"
& $ffmpeg -y -f lavfi -i "sine=frequency=520:duration=3" -ac 1 -ar 44100 $wav *> $null
if (-not (Test-Path $wav)) { Fail "ffmpeg nao gerou o arquivo."; exit 1 }
Ok "Arquivo de origem: $wav"

# --- 2) login ---
Step "Login no painel ($Email)"
$loginFile = Join-Path $tmp "login.json"
@{ email = $Email; password = $Password } | ConvertTo-Json | Set-Content -Path $loginFile -Encoding UTF8
$login = & curl.exe -s -X POST "$BaseUrl/api/auth/login" -H "Content-Type: application/json" --data "@$loginFile" | ConvertFrom-Json
$token = $login.token
if (-not $token) { Fail "Login falhou: $($login | ConvertTo-Json -Compress)"; exit 1 }
Ok "Autenticado como $($login.user.name)"

# --- 3) cadastrar audio (upload -> ffmpeg ogg/opus -> banco) ---
Step "Cadastrando audio (upload -> conversao ogg/opus -> banco)"
$up = & curl.exe -s -X POST "$BaseUrl/api/audios" `
  -H "Authorization: Bearer $token" `
  -F "file=@$wav;type=audio/wav" `
  -F "title=Promo da semana (teste)" `
  -F "category=promocao" `
  -F "tone=animado" `
  -F "situation=Quando o cliente pergunta sobre promocoes" `
  -F "transcription=Temos sim! Essa semana tem condicao especial no atacado." `
  -F "keywords=promocao,oferta" | ConvertFrom-Json
$audioId = $up.audio.id
if (-not $audioId) { Fail "Upload falhou: $($up | ConvertTo-Json -Compress)"; exit 1 }
Ok "Audio salvo no banco: id=$audioId"
Info "URL publica : $($up.audio.file_url)"
Info "Formato     : .ogg/opus (PTT WhatsApp) | duracao $($up.audio.duration_seconds)s | $($up.audio.file_size_kb) KB"

# --- 4) vincular palavra-chave -> audio ---
Step "Vinculando a palavra-chave '$Keyword' ao audio"
$kwFile = Join-Path $tmp "keyword.json"
@{ keyword = $Keyword; intent = "promocao"; content_type = "audio"; content_id = $audioId; priority = 5 } |
  ConvertTo-Json | Set-Content -Path $kwFile -Encoding UTF8
$kw = & curl.exe -s -X POST "$BaseUrl/api/keywords" -H "Authorization: Bearer $token" -H "Content-Type: application/json" --data "@$kwFile" | ConvertFrom-Json
if (-not $kw.keyword.id) { Fail "Criacao da keyword falhou: $($kw | ConvertTo-Json -Compress)"; exit 1 }
Ok "Keyword criada: '$($kw.keyword.keyword)' -> audio $audioId"

# --- 5) simular mensagem do cliente ---
Step "Simulando mensagem do cliente: '$TriggerMessage'"
$hookFile = Join-Path $tmp "webhook.json"
@{
  phone      = $Phone
  fromMe     = $false
  messageId  = "AUDIOTEST-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
  senderName = $SenderName
  text       = @{ message = $TriggerMessage }
} | ConvertTo-Json -Depth 5 | Set-Content -Path $hookFile -Encoding UTF8
$hook = & curl.exe -s -X POST "$BaseUrl/webhook/whatsapp" -H "Content-Type: application/json" --data "@$hookFile" | ConvertFrom-Json
Ok "Webhook respondeu: $($hook | ConvertTo-Json -Compress)"

Info "Aguardando processamento assincrono..."
Start-Sleep -Seconds 3

# --- 6) verificar que o audio foi devolvido na conversa ---
Step "Verificando a conversa e o audio devolvido"
$convs = (& curl.exe -s "$BaseUrl/api/conversations" -H "Authorization: Bearer $token" | ConvertFrom-Json).conversations
$conv = $convs | Where-Object { $_.client_phone -eq $Phone } | Select-Object -First 1
if (-not $conv) { Fail "Conversa do telefone $Phone nao encontrada."; exit 1 }
Ok "Conversa encontrada: id=$($conv.id) | cliente=$($conv.client_name)"

$detail = & curl.exe -s "$BaseUrl/api/conversations/$($conv.id)" -H "Authorization: Bearer $token" | ConvertFrom-Json
$messages = $detail.messages

Write-Host "`n--- Timeline da conversa ---" -ForegroundColor Yellow
foreach ($m in $messages) {
  $dir = if ($m.direction -eq "inbound") { "CLIENTE  " } else { "MARYLAND " }
  $color = if ($m.direction -eq "inbound") { "White" } else { "Magenta" }
  $body = if ($m.type -eq "audio") { "[AUDIO] $($m.content)" } else { $m.content }
  Write-Host ("  {0}({1}) {2}" -f $dir, $m.type, $body) -ForegroundColor $color
}

$audioMsg = $messages | Where-Object { $_.type -eq "audio" -and $_.direction -eq "outbound" } | Select-Object -First 1
Write-Host ""
if ($audioMsg) {
  Ok "SUCESSO: a Maryland devolveu um AUDIO ao cliente!"
  Info "Mensagem de audio: $($audioMsg.content)"
  Info "Voce pode ouvir esse audio no painel, abrindo a conversa de '$SenderName'."
} else {
  Fail "Nenhuma mensagem de audio outbound encontrada. Verifique o log do servidor."
  Info "Dica: confira se o WhatsApp esta em modo simulado e se a keyword casou."
}
