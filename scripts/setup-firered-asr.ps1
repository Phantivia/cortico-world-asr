param([string]$RuntimeDir = '', [string]$ModelDir = '')
$ErrorActionPreference = 'Stop'
$repoDir = Split-Path $PSScriptRoot -Parent
if (!$RuntimeDir) { $RuntimeDir = Join-Path $repoDir 'runtime/firered-server' }
if (!$ModelDir) { $ModelDir = Join-Path (Split-Path $repoDir -Parent) 'Cortico-Resources/models/asr/FireRedASR2-AED' }
$sourceDir = Join-Path $RuntimeDir 'FireRedASR2S'
$venvDir = Join-Path $RuntimeDir '.venv'
$pythonExe = Join-Path $venvDir 'Scripts/python.exe'
$sourceRevision = '4e7d9aaf4482a47cec1724807026b9b151926eb5'
$modelRevision = '2304afed56eacfee6256dee5937ed22ffa0b64ec'
New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
if (!(Test-Path -LiteralPath $sourceDir)) {
    git clone https://github.com/FireRedTeam/FireRedASR2S.git $sourceDir
    if ($LASTEXITCODE -ne 0) { throw 'FireRed source download failed' }
    git -C $sourceDir checkout --detach $sourceRevision
    if ($LASTEXITCODE -ne 0) { throw 'FireRed source revision is unavailable' }
}
$actualRevision = git -C $sourceDir rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $actualRevision -ne $sourceRevision) {
    throw "Expected FireRed source revision $sourceRevision in $sourceDir"
}
if (!(Test-Path -LiteralPath $pythonExe)) {
    uv venv --python 3.12 $venvDir
    if ($LASTEXITCODE -ne 0) { throw 'Python environment creation failed' }
}
uv pip install --python $pythonExe torch==2.9.1+cu128 torchaudio==2.9.1+cu128 torchvision==0.24.1+cu128 --index-url https://download.pytorch.org/whl/cu128
if ($LASTEXITCODE -ne 0) { throw 'PyTorch installation failed' }
uv pip install --python $pythonExe -r (Join-Path $repoDir 'src/firered-requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'FireRed dependencies installation failed' }
$requiredFiles = @('model.pth.tar', 'cmvn.ark', 'dict.txt', 'train_bpe1000.model')
$missingFiles = @($requiredFiles | Where-Object { !(Test-Path -LiteralPath (Join-Path $ModelDir $_) -PathType Leaf) })
if ($missingFiles.Count -gt 0) {
    & $pythonExe -c 'from huggingface_hub import snapshot_download; import sys; snapshot_download("FireRedTeam/FireRedASR2-AED", revision=sys.argv[1], local_dir=sys.argv[2])' $modelRevision $ModelDir
    if ($LASTEXITCODE -ne 0) { throw 'FireRed weights download failed' }
}
Write-Output "FireRed runtime ready: $RuntimeDir"
Write-Output "worlds.asr.backend.modelFile: $(Join-Path $ModelDir 'model.pth.tar')"
