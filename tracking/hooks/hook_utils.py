import subprocess
import sys


def run_git(args, capture=False, check=False, env=None):
    try:
        result = subprocess.run(
            ["git"] + args,
            text=True,
            stdout=subprocess.PIPE if capture else None,
            stderr=sys.stderr,
            check=check,
            env=env
        )
        return result.stdout.strip() if capture else result.returncode == 0
    except Exception:
        return None if capture else False


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
