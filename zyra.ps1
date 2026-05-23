$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cli = Join-Path $Root "bin\zyra.mjs"

node $Cli @args
exit $LASTEXITCODE
