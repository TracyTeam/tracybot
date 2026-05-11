import subprocess

PUSH_RULES = [
    "HEAD",
    "refs/tracy/*:refs/tracy/*",
    "refs/notes/*:refs/notes/*",
]


def run_git(args, capture=False, check=False):
    try:
        result = subprocess.run(
            ["git"] + args,
            text=True,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.DEVNULL,
            check=check
        )
        return result.stdout.strip() if capture else result.returncode == 0
    except subprocess.CalledProcessError:
        return None if capture else False


def origin_exists():
    return run_git(["remote", "get-url", "origin"], capture=True) is not None


def get_push_rules():
    output = run_git(["config", "--get-all", "remote.origin.push"], capture=True)
    if not output:
        return set()
    return {line.strip() for line in output.splitlines() if line.strip()}


def add_push_rules():
    existing = get_push_rules()

    print(existing)

    for rule in PUSH_RULES:
        if rule not in existing:
            run_git(["config", "--add", "remote.origin.push", rule])


def main():
    if not origin_exists():
        return

    add_push_rules()


if __name__ == "__main__":
    main()