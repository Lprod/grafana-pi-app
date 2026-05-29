from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from demo.prometheus.generate_openmetrics import (
    CPU_COUNT,
    DEFAULT_FUTURE_SECONDS,
    DEFAULT_HISTORY_HOURS,
    DEFAULT_INCIDENT_DURATION_SECONDS,
    DEFAULT_STEP_SECONDS,
    HISTOGRAM_BUCKETS,
    HOSTS,
    METHOD,
    WEB_ROUTES,
    counter_value,
    cpu_mode_fraction,
    filesystem_free_bytes,
    filesystem_size_bytes,
    error_ratio,
    histogram_bucket_count,
    incident_intensity,
    latency_seconds,
    load1,
    memory_available_bytes,
    memory_total_bytes,
    traffic_rps,
)


def escape_measurement(value: str) -> str:
    return value.replace("\\", "\\\\").replace(" ", "\\ ").replace(",", "\\,")


def escape_tag(value: str) -> str:
    return value.replace("\\", "\\\\").replace(" ", "\\ ").replace(",", "\\,").replace("=", "\\=")


def tag_set(tags: dict[str, str]) -> str:
    if not tags:
        return ""
    encoded = ",".join(f"{escape_tag(key)}={escape_tag(value)}" for key, value in sorted(tags.items()))
    return f",{encoded}"


def point(measurement: str, value: float, timestamp_seconds: int, **tags: str) -> str:
    return f"{escape_measurement(measurement)}{tag_set(tags)} value={value:.6f} {timestamp_seconds}"


def render_influx_points(elapsed_seconds: float, timestamp_seconds: int, incident_start_seconds: float) -> list[str]:
    t = max(0.0, elapsed_seconds)
    lines: list[str] = []

    for vm in HOSTS:
        for cpu in range(CPU_COUNT):
            for mode in ("idle", "user", "system", "iowait"):
                value = counter_value(
                    lambda moment, vm=vm, mode=mode: cpu_mode_fraction(vm, mode, moment, incident_start_seconds),
                    t,
                )
                lines.append(
                    point(
                        "node_cpu_seconds_total",
                        value,
                        timestamp_seconds,
                        cpu=str(cpu),
                        mode=mode,
                        vm=vm,
                        instance=f"{vm}:9100",
                        job="node",
                    )
                )

    for vm in HOSTS:
        lines.append(
            point(
                "node_load1",
                load1(vm, t, incident_start_seconds),
                timestamp_seconds,
                vm=vm,
                instance=f"{vm}:9100",
                job="node",
            )
        )
        lines.append(
            point(
                "node_memory_MemTotal_bytes",
                memory_total_bytes(vm),
                timestamp_seconds,
                vm=vm,
                instance=f"{vm}:9100",
                job="node",
            )
        )
        lines.append(
            point(
                "node_memory_MemAvailable_bytes",
                memory_available_bytes(vm, t),
                timestamp_seconds,
                vm=vm,
                instance=f"{vm}:9100",
                job="node",
            )
        )
        lines.append(
            point(
                "node_filesystem_size_bytes",
                filesystem_size_bytes(vm),
                timestamp_seconds,
                vm=vm,
                mountpoint="/",
                fstype="ext4",
                instance=f"{vm}:9100",
                job="node",
            )
        )
        lines.append(
            point(
                "node_filesystem_free_bytes",
                filesystem_free_bytes(vm, t),
                timestamp_seconds,
                vm=vm,
                mountpoint="/",
                fstype="ext4",
                instance=f"{vm}:9100",
                job="node",
            )
        )
        receive = counter_value(
            lambda moment, vm=vm: 280_000 + 40_000 * incident_intensity(moment, incident_start_seconds)
            if vm.startswith("vm-web")
            else 90_000,
            t,
        )
        transmit = counter_value(
            lambda moment, vm=vm: 360_000 + 70_000 * incident_intensity(moment, incident_start_seconds)
            if vm.startswith("vm-web")
            else 120_000,
            t,
        )
        lines.append(
            point(
                "node_network_receive_bytes_total",
                receive,
                timestamp_seconds,
                vm=vm,
                device="eth0",
                instance=f"{vm}:9100",
                job="node",
            )
        )
        lines.append(
            point(
                "node_network_transmit_bytes_total",
                transmit,
                timestamp_seconds,
                vm=vm,
                device="eth0",
                instance=f"{vm}:9100",
                job="node",
            )
        )

    for vm in ("vm-web-01", "vm-web-02"):
        for route in WEB_ROUTES:
            ok_rate = lambda moment, vm=vm, route=route: traffic_rps(vm, route, moment, incident_start_seconds) * (
                1.0 - error_ratio(vm, route, moment, incident_start_seconds)
            )
            err_rate = (
                lambda moment, vm=vm, route=route: traffic_rps(vm, route, moment, incident_start_seconds)
                * error_ratio(vm, route, moment, incident_start_seconds)
            )
            lines.append(
                point(
                    "http_requests_total",
                    counter_value(ok_rate, t),
                    timestamp_seconds,
                    vm=vm,
                    route=route,
                    method=METHOD,
                    status="200",
                    job="web",
                )
            )
            lines.append(
                point(
                    "http_requests_total",
                    counter_value(err_rate, t),
                    timestamp_seconds,
                    vm=vm,
                    route=route,
                    method=METHOD,
                    status="500",
                    job="web",
                )
            )

            total_requests = counter_value(
                lambda moment, vm=vm, route=route: traffic_rps(vm, route, moment, incident_start_seconds),
                t,
            )
            avg_latency = latency_seconds(vm, route, 0.50, t, incident_start_seconds)
            lines.append(
                point(
                    "http_request_duration_seconds_sum",
                    total_requests * avg_latency,
                    timestamp_seconds,
                    vm=vm,
                    route=route,
                    method=METHOD,
                    job="web",
                )
            )
            lines.append(
                point(
                    "http_request_duration_seconds_count",
                    total_requests,
                    timestamp_seconds,
                    vm=vm,
                    route=route,
                    method=METHOD,
                    job="web",
                )
            )
            inflight = traffic_rps(vm, route, t, incident_start_seconds) * latency_seconds(
                vm, route, 0.70, t, incident_start_seconds
            )
            lines.append(
                point(
                    "http_inflight_requests",
                    inflight,
                    timestamp_seconds,
                    vm=vm,
                    route=route,
                    method=METHOD,
                    job="web",
                )
            )
            for bucket in HISTOGRAM_BUCKETS:
                lines.append(
                    point(
                        "http_request_duration_seconds_bucket",
                        histogram_bucket_count(vm, route, bucket, t, incident_start_seconds),
                        timestamp_seconds,
                        vm=vm,
                        route=route,
                        method=METHOD,
                        le=str(bucket),
                        job="web",
                    )
                )
            lines.append(
                point(
                    "http_request_duration_seconds_bucket",
                    total_requests,
                    timestamp_seconds,
                    vm=vm,
                    route=route,
                    method=METHOD,
                    le="+Inf",
                    job="web",
                )
            )

    return lines


def render_line_protocol_history(
    start_timestamp: int, total_seconds: int, step_seconds: int, incident_start_seconds: int
) -> str:
    lines: list[str] = []
    for elapsed in range(0, total_seconds + 1, step_seconds):
        timestamp_seconds = start_timestamp + elapsed
        lines.extend(render_influx_points(elapsed, timestamp_seconds, incident_start_seconds))
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Write historical InfluxDB line-protocol samples for the Observability Analyst local demo stack."
    )
    parser.add_argument("--output", default=os.getenv("INFLUX_LINE_PROTOCOL_OUTPUT", "/demo/history.lp"))
    parser.add_argument("--hours", type=int, default=int(os.getenv("HISTORY_HOURS", str(DEFAULT_HISTORY_HOURS))))
    parser.add_argument(
        "--step-seconds", type=int, default=int(os.getenv("HISTORY_STEP_SECONDS", str(DEFAULT_STEP_SECONDS)))
    )
    parser.add_argument(
        "--incident-duration-seconds",
        type=int,
        default=int(os.getenv("INCIDENT_DURATION_SECONDS", str(DEFAULT_INCIDENT_DURATION_SECONDS))),
    )
    parser.add_argument(
        "--future-seconds", type=int, default=int(os.getenv("HISTORY_FUTURE_SECONDS", str(DEFAULT_FUTURE_SECONDS)))
    )
    parser.add_argument("--end-timestamp", type=int, default=int(os.getenv("HISTORY_END_TIMESTAMP", "0")) or None)
    args = parser.parse_args()

    history_seconds = args.hours * 3600
    incident_start_seconds = max(0, history_seconds - args.incident_duration_seconds)
    end_timestamp = int(args.end_timestamp or time.time())
    start_timestamp = end_timestamp - history_seconds
    total_seconds = history_seconds + max(0, args.future_seconds)
    output = Path(args.output)

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        render_line_protocol_history(
            start_timestamp=start_timestamp,
            total_seconds=total_seconds,
            step_seconds=args.step_seconds,
            incident_start_seconds=incident_start_seconds,
        ),
        encoding="utf-8",
    )
    print(
        f"wrote {output} with {args.hours}h of history and {max(0, args.future_seconds)}s "
        f"of current-query overlap ending at unix timestamp {end_timestamp + max(0, args.future_seconds)}"
    )


if __name__ == "__main__":
    main()
