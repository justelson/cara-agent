$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cli = Join-Path $Root "bin\cara.mjs"

node $Cli @args
exit $LASTEXITCODE
