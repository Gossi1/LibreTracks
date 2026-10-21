@echo off
rem Sets up analysis-service: a venv with allin1 + NATTEN 0.17.4 built from
rem source against MSVC. Safe to re-run; every step is idempotent.
setlocal
cd /d "%~dp0"

set PYTHON=python
if exist ".venv\Scripts\python.exe" set PYTHON=.venv\Scripts\python.exe

if not exist ".venv\Scripts\python.exe" (
  echo [1/6] creating venv...
  python -m venv .venv || exit /b 1
  set PYTHON=.venv\Scripts\python.exe
)

echo [2/6] CPU-only torch...
"%PYTHON%" -m pip install --index-url https://download.pytorch.org/whl/cpu torch==2.5.1 torchaudio==2.5.1 || exit /b 1

echo [3/6] allin1 + ffmpeg...
"%PYTHON%" -m pip install -r requirements.txt || exit /b 1

echo [4/6] madmom (allin1's framing helper, needs a source build)...
"%PYTHON%" -m pip install "git+https://github.com/CPJKU/madmom" || exit /b 1

echo [5/6] exposing python312.lib to the linker...
rem A venv has no Scripts\libs, but NATTEN's CMake points there. Copy the
rem import libraries from the base interpreter or the link fails with
rem "LNK1104: cannot open file 'python312.lib'".
for /f "delims=" %%i in ('"%PYTHON%" -c "import sys,os;print(os.path.join(sys.base_prefix,chr(108)+chr(105)+chr(98)+chr(115)))"') do set BASELIBS=%%i
if not exist ".venv\Scripts\libs" mkdir ".venv\Scripts\libs"
copy /y "%BASELIBS%\python3*.lib" ".venv\Scripts\libs\" >nul

echo [6/6] building NATTEN 0.17.4 from source (this takes a few minutes)...
rem NATTEN picks the Ninja generator, which needs cl.exe on PATH - that is what
rem vcvars64.bat provides. Do not skip it.
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 (
  echo Could not find Visual Studio Build Tools. Install the C++ build tools,
  echo or edit the vcvars64.bat path above.
  exit /b 1
)
"%PYTHON%" -m pip install --upgrade setuptools wheel ninja || exit /b 1
set CMAKE_BUILD_PARALLEL_LEVEL=4
"%PYTHON%" -m pip install --no-build-isolation natten==0.17.4 || exit /b 1

echo.
echo Verifying...
"%PYTHON%" -c "from natten.functional import natten1dav; import allin1; print('OK: allin1 + NATTEN ready')"
exit /b %ERRORLEVEL%
