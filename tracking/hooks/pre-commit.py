import sys
import subprocess
from pathlib import Path


def load_config(path):
    config = {}
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, val = line.split("=", 1)
                config[key.strip()] = val.strip()
    return config


# This hook is a tracking convenience, not a policy gate — it must never be
# able to block a real commit, no matter why the tracking step failed (a
# stale config after an extension update, a missing script, a bug in
# tracy.py itself, ...). Every failure path here prints a warning and exits
# 0 instead of aborting the commit, unlike a normal validation hook.
def warn_and_allow(message):
    print(f"Warning: {message} — Tracybot snapshot skipped, commit proceeding.", file=sys.stderr)
    sys.exit(0)


def main():
    script_dir = Path(__file__).resolve().parent
    config_file = script_dir.parent / "tracybot" / "config"

    # -------------------------------
    # CHECK CONFIG FILE
    # -------------------------------
    if not config_file.exists():
        warn_and_allow(f"config file '{config_file}' not found")

    try:
        config = load_config(config_file)
    except OSError as e:
        warn_and_allow(f"could not read config file: {e}")

    tracy_script = config.get("TRACY_SNAPSHOT_SCRIPT", "")

    # -------------------------------
    # VALIDATE TRACY_SCRIPT
    # -------------------------------
    if not tracy_script:
        warn_and_allow("TRACY_SNAPSHOT_SCRIPT is not set in the config file")

    tracy_path = Path(tracy_script)

    if not tracy_path.exists():
        warn_and_allow(f"TRACY_SNAPSHOT_SCRIPT is set to '{tracy_script}' but the file does not exist")

    # -------------------------------
    # EXECUTE SCRIPT
    # -------------------------------
    try:
        subprocess.run(
            [sys.executable, str(tracy_path), "--index-only"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
    except Exception as e:
        print(f"Warning: error executing Tracy script: {e} — commit proceeding.", file=sys.stderr)

    sys.exit(0)


if __name__ == "__main__":
    main()
