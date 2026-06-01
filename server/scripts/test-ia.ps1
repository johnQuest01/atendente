param(
  [string]$Message = "Oi! Aqui e o Joao da Farmacia Bem Estar. Voces tem dipirona no atacado? Qual o preco e o pedido minimo?",
  [string]$Phone = "5511988887777",
  [string]$Name = "Joao Teste",
  [string]$Url = "http://localhost:3001/webhook/whatsapp"
)

# Script de teste de ponta a ponta da IA (Mayra).
# Simula uma mensagem chegando pelo webhook do WhatsApp.
# Uso:
#   powershell -ExecutionPolicy Bypass -File server/scripts/test-ia.ps1
#   powershell -ExecutionPolicy Bypass -File server/scripts/test-ia.ps1 -Message "Quanto custa o frete?"

$payload = @{
  phone      = $Phone
  fromMe     = $false
  messageId  = "TEST-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
  senderName = $Name
  text       = @{ message = $Message }
} | ConvertTo-Json -Depth 5

Write-Host "==> Enviando mensagem de teste para $Url" -ForegroundColor Cyan
Write-Host "    Cliente: $Name ($Phone)" -ForegroundColor DarkGray
Write-Host "    Mensagem: $Message" -ForegroundColor DarkGray
Write-Host ""

try {
  $resp = Invoke-WebRequest -Uri $Url -Method POST -ContentType 'application/json' -Body $payload -UseBasicParsing
  Write-Host "==> Webhook respondeu: $($resp.Content)" -ForegroundColor Green
  Write-Host ""
  Write-Host "A IA processa de forma assincrona. Veja a resposta no LOG do servidor" -ForegroundColor Yellow
  Write-Host "(o terminal onde rodou 'npm run dev')." -ForegroundColor Yellow
} catch {
  Write-Host "==> ERRO ao chamar o webhook:" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
}
