param(
    [Parameter(Position = 0)]
    [string]$Mensagem
)

$ErrorActionPreference = 'Stop'
$Repositorio = Split-Path -Parent $MyInvocation.MyCommand.Path
$GitDisponivel = Get-Command git -ErrorAction SilentlyContinue
$GitExecutavel = if ($GitDisponivel) { $GitDisponivel.Source } else { Join-Path $Repositorio '.git-tools\portable\cmd\git.exe' }
$GerenciadorCredenciais = Join-Path $Repositorio '.git-tools\portable\ucrt64\bin\git-credential-manager.exe'

if (-not (Test-Path -LiteralPath $GitExecutavel)) {
    throw "Git não encontrado. Instale o Git for Windows ou coloque a versão portátil em .git-tools\portable."
}

function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Argumentos)
    if (Test-Path -LiteralPath $GerenciadorCredenciais) {
        $ComandoCredenciais = '!"' + ($GerenciadorCredenciais -replace '\\', '/') + '"'
        & $GitExecutavel -c credential.helper= -c "credential.helper=$ComandoCredenciais" -C $Repositorio @Argumentos
    } else {
        & $GitExecutavel -C $Repositorio @Argumentos
    }
    if ($LASTEXITCODE -ne 0) {
        throw "O comando git $($Argumentos -join ' ') falhou (código $LASTEXITCODE)."
    }
}

$Raiz = (& $GitExecutavel -C $Repositorio rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $Raiz) { throw 'Esta pasta não está dentro de um repositório Git válido.' }
$Nome = (& $GitExecutavel -C $Repositorio config user.name 2>$null)
$Email = (& $GitExecutavel -C $Repositorio config user.email 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $Nome -or -not $Email -or $Email -eq 'codex@localhost') { throw 'Configure seu nome e e-mail Git seguindo a seção Publicar atualizações no GitHub do README.md.' }
$Remoto = (& $GitExecutavel -C $Repositorio remote get-url origin 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $Remoto) { throw 'O remoto origin não está configurado. Confira a seção Git no README.md.' }
$Branch = (& $GitExecutavel -C $Repositorio branch --show-current)
if ($LASTEXITCODE -ne 0 -or -not $Branch) { throw 'Não foi possível identificar a branch atual.' }
Invoke-Git add --all
& $GitExecutavel -C $Repositorio diff --cached --quiet
if ($LASTEXITCODE -eq 0) { Write-Host 'Não há alterações para publicar.'; exit 0 }
if ($LASTEXITCODE -ne 1) { throw 'Não foi possível verificar as alterações preparadas.' }
if (-not $Mensagem) { $Mensagem = "Atualização do projeto $(Get-Date -Format 'yyyy-MM-dd HH:mm')" }
Invoke-Git commit -m $Mensagem
Invoke-Git push --set-upstream origin $Branch
Write-Host "Publicação concluída em origin/$Branch."
