from SpotAlert.cli import main


def test_cli_returns_success_when_availability_is_found(monkeypatch) -> None:
    monkeypatch.setattr(
        "SpotAlert.cli.AvailabilityChecker.check",
        lambda *_args: type(
            "Result",
            (),
            {"available": True, "url": "https://example.com/studios"},
        )(),
    )

    exit_code = main(
        [
            "check",
            "https://example.com/studios",
            "--available-text",
            "Available",
        ]
    )

    assert exit_code == 0


def test_cli_returns_unavailable_exit_code(monkeypatch) -> None:
    monkeypatch.setattr(
        "SpotAlert.cli.AvailabilityChecker.check",
        lambda *_args: type(
            "Result",
            (),
            {"available": False, "url": "https://example.com/studios"},
        )(),
    )

    exit_code = main(
        [
            "check",
            "https://example.com/studios",
            "--available-text",
            "Available",
        ]
    )

    assert exit_code == 1


def test_cli_starts_terminal_interface(monkeypatch) -> None:
    run_calls = 0

    def run(*_args: object) -> None:
        nonlocal run_calls
        run_calls += 1

    monkeypatch.setattr("SpotAlert.cli.SpotAlertApp.run", run)

    exit_code = main(["tui"])

    assert exit_code == 0
    assert run_calls == 1
