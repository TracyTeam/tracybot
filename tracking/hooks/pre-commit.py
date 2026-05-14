from hook_utils import load_config
import os
import sys
from pathlib import Path


def main():
    script_dir = Path(__file__).resolve().parent
    config_file = script_dir.parent / "tracybot" / "config"

    # -------------------------------
    # CHECK CONFIG FILE
    # -------------------------------
    if not config_file.exists():
        print(f"Error: Config file '{config_file}' not found.", file=sys.stderr)
        sys.exit(1)

    config = load_config(config_file)

    tracy_script = config.get("TRACY_SNAPSHOT_SCRIPT", "")

    # -------------------------------
    # VALIDATE TRACY_SCRIPT
    # -------------------------------
    if not tracy_script:
        print("Error: TRACY_SNAPSHOT_SCRIPT is not set in the config file.", file=sys.stderr)
        sys.exit(1)

    tracy_path = Path(tracy_script)

    if not tracy_path.exists():
        print(f"Error: TRACY_SNAPSHOT_SCRIPT is set to '{tracy_script}' but the file does not exist.", file=sys.stderr)
        sys.exit(1)

    # -------------------------------
    # EXECUTE SCRIPT
    # -------------------------------
    try:
        result = subprocess.run(
            [sys.executable, str(tracy_path), "--index-only"],
            stdout=subprocess.DEVNULL,
            stderr=sys.stderr
        )
        sys.exit(result.returncode)
    except Exception as e:
        print(f"Error executing Tracy script: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
