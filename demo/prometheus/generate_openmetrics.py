from __future__ import annotations

import argparse
import math
import os
import time
from collections.abc import Callable, Iterable
from pathlib import Path


HOSTS = ("vm-web-01", "vm-web-02", "vm-db-01")
WEB_ROUTES = ("/", "/api/orders", "/render/report")
METHOD = "GET"
CPU_COUNT = 2
HISTOGRAM_BUCKETS = (0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0)
DEFAULT_HISTORY_HOURS = 6
DEFAULT_STEP_SECONDS = 60
DEFAULT_INCIDENT_DURATION_SECONDS = 900
DEFAULT_FUTURE_SECONDS = 3600


def clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def ramp(t: float, start: float, end: float) -> float:
    if end <= start:
        return 1.0 if t >= end else 0.0
    return clamp((t - start) / (end - start), 0.0, 1.0)


def incident_intensity(t: float, incident_start_seconds: float) -> float:
    local_t = t - incident_start_seconds
    rise = ramp(local_t, 180, 540)
    fall = ramp(local_t, 720, 840)
    return clamp(rise * (1.0 - fall), 0.0, 1.0)


def cpu_utilization(vm: str, t: float, incident_start_seconds: float) -> float:
    wave = 0.03 * math.sin(t / 37.0)
    if vm == "vm-web-01":
        return clamp(0.18 + wave + 0.78 * incident_intensity(t, incident_start_seconds), 0.05, 0.98)
    if vm == "vm-web-02":
        return clamp(0.16 + wave + 0.12 * incident_intensity(t, incident_start_seconds), 0.05, 0.45)
    return clamp(0.22 + 0.02 * math.sin(t / 55.0), 0.08, 0.38)


def load1(vm: str, t: float, incident_start_seconds: float) -> float:
    if vm == "vm-web-01":
        return round(0.45 + 4.9 * incident_intensity(t, incident_start_seconds), 3)
    if vm == "vm-web-02":
        return round(0.35 + 0.55 * incident_intensity(t, incident_start_seconds), 3)
    return round(0.55 + 0.08 * math.sin(t / 41.0), 3)


def memory_total_bytes(vm: str) -> float:
    gib = 1024 * 1024 * 1024
    return 8 * gib if vm.startswith("vm-web") else 16 * gib


def memory_available_bytes(vm: str, t: float) -> float:
    used_ratio = 0.42 + 0.05 * math.sin(t / 180.0) if vm.startswith("vm-web") else 0.58 + 0.04 * math.sin(t / 150.0)
    return memory_total_bytes(vm) * (1.0 - used_ratio)


def filesystem_size_bytes(vm: str) -> float:
    gib = 1024 * 1024 * 1024
    return 80 * gib if vm.startswith("vm-web") else 200 * gib


def filesystem_free_bytes(vm: str, t: float) -> float:
    baseline = 0.62 if vm.startswith("vm-web") else 0.48
    return filesystem_size_bytes(vm) * (baseline + 0.015 * math.sin(t / 210.0))


def traffic_rps(vm: str, route: str, t: float, incident_start_seconds: float) -> float:
    route_base = {
        "/": 18.0,
        "/api/orders": 8.0,
        "/render/report": 3.0,
    }[route]
    host_share = 0.52 if vm == "vm-web-01" else 0.48
    return route_base * host_share * (1.0 + 0.08 * math.sin(t / 95.0))


def error_ratio(vm: str, route: str, t: float, incident_start_seconds: float) -> float:
    base = 0.002
    if vm == "vm-web-01" and route == "/render/report":
        return base + 0.14 * incident_intensity(t, incident_start_seconds)
    if vm == "vm-web-01":
        return base + 0.035 * incident_intensity(t, incident_start_seconds)
    return base + 0.004 * incident_intensity(t, incident_start_seconds)


def latency_seconds(vm: str, route: str, quantile_hint: float, t: float, incident_start_seconds: float) -> float:
    base = {
        "/": 0.055,
        "/api/orders": 0.11,
        "/render/report": 0.32,
    }[route]
    if vm == "vm-web-01":
        multiplier = 1.0 + incident_intensity(t, incident_start_seconds) * (7.0 if route == "/render/report" else 3.2)
    else:
        multiplier = 1.0 + incident_intensity(t, incident_start_seconds) * 0.45
    return base * multiplier * (1.0 + quantile_hint * 1.8)


def integrate_rate(rate_func: Callable[[float], float], t: float, step: float = 15.0) -> float:
    if t <= 0:
        return 0.0
    total = 0.0
    cursor = 0.0
    while cursor < t:
        interval = min(step, t - cursor)
        midpoint = cursor + interval / 2.0
        total += rate_func(midpoint) * interval
        cursor += interval
    return total


def cpu_mode_fraction(vm: str, mode: str, t: float, incident_start_seconds: float) -> float:
    utilization = cpu_utilization(vm, t, incident_start_seconds)
    if mode == "idle":
        return 1.0 - utilization
    if mode == "user":
        return utilization * (0.72 if vm == "vm-web-01" else 0.62)
    if mode == "system":
        return utilization * (0.22 if vm.startswith("vm-web") else 0.18)
    if mode == "iowait":
        return 0.01 + (0.015 if vm == "vm-db-01" else 0.005)
    return 0.0


def counter_value(rate_func: Callable[[float], float], t: float) -> float:
    return integrate_rate(rate_func, t)


def histogram_bucket_count(vm: str, route: str, le: float, t: float, incident_start_seconds: float) -> float:
    def rate_at(moment: float) -> float:
        rps = traffic_rps(vm, route, moment, incident_start_seconds)
        p95 = latency_seconds(vm, route, 0.95, moment, incident_start_seconds)
        if le >= 10.0:
            return rps
        fraction = clamp(1.0 - math.exp(-le / max(p95 / 3.0, 0.001)), 0.0, 1.0)
        return rps * fraction

    return integrate_rate(rate_at, t)


def labels(**values: str) -> str:
    encoded = ",".join(f'{key}="{value}"' for key, value in values.items())
    return f"{{{encoded}}}"


def sample(name: str, value: float, **label_values: str) -> str:
    return f"{name}{labels(**label_values)} {value:.6f}"


def metric_family(name: str, metric_type: str, help_text: str, samples: Iterable[str]) -> list[str]:
    return [
        f"# HELP {name} {help_text}",
        f"# TYPE {name} {metric_type}",
        *samples,
    ]


def render_prometheus_metrics(elapsed_seconds: float, incident_start_seconds: float) -> str:
    t = max(0.0, elapsed_seconds)
    lines: list[str] = []

    cpu_samples: list[str] = []
    for vm in HOSTS:
        for cpu in range(CPU_COUNT):
            for mode in ("idle", "user", "system", "iowait"):
                value = integrate_rate(lambda moment, vm=vm, mode=mode: cpu_mode_fraction(vm, mode, moment, incident_start_seconds), t)
                cpu_samples.append(sample("node_cpu_seconds_total", value, cpu=str(cpu), mode=mode, vm=vm, instance=f"{vm}:9100", job="node"))
    lines.extend(metric_family("node_cpu_seconds_total", "counter", "Seconds the CPUs spent in each mode.", cpu_samples))

    lines.extend(
        metric_family(
            "node_load1",
            "gauge",
            "One minute load average.",
            [sample("node_load1", load1(vm, t, incident_start_seconds), vm=vm, instance=f"{vm}:9100", job="node") for vm in HOSTS],
        )
    )

    mem_total_samples = []
    mem_available_samples = []
    fs_size_samples = []
    fs_free_samples = []
    for vm in HOSTS:
        mem_total_samples.append(sample("node_memory_MemTotal_bytes", memory_total_bytes(vm), vm=vm, instance=f"{vm}:9100", job="node"))
        mem_available_samples.append(sample("node_memory_MemAvailable_bytes", memory_available_bytes(vm, t), vm=vm, instance=f"{vm}:9100", job="node"))
        fs_size_samples.append(sample("node_filesystem_size_bytes", filesystem_size_bytes(vm), vm=vm, mountpoint="/", fstype="ext4", instance=f"{vm}:9100", job="node"))
        fs_free_samples.append(sample("node_filesystem_free_bytes", filesystem_free_bytes(vm, t), vm=vm, mountpoint="/", fstype="ext4", instance=f"{vm}:9100", job="node"))
    lines.extend(metric_family("node_memory_MemTotal_bytes", "gauge", "Total memory.", mem_total_samples))
    lines.extend(metric_family("node_memory_MemAvailable_bytes", "gauge", "Available memory.", mem_available_samples))
    lines.extend(metric_family("node_filesystem_size_bytes", "gauge", "Filesystem size.", fs_size_samples))
    lines.extend(metric_family("node_filesystem_free_bytes", "gauge", "Filesystem free bytes.", fs_free_samples))

    receive_samples = []
    transmit_samples = []
    for vm in HOSTS:
        receive = counter_value(lambda moment, vm=vm: 280_000 + 40_000 * incident_intensity(moment, incident_start_seconds) if vm.startswith("vm-web") else 90_000, t)
        transmit = counter_value(lambda moment, vm=vm: 360_000 + 70_000 * incident_intensity(moment, incident_start_seconds) if vm.startswith("vm-web") else 120_000, t)
        receive_samples.append(sample("node_network_receive_bytes_total", receive, vm=vm, device="eth0", instance=f"{vm}:9100", job="node"))
        transmit_samples.append(sample("node_network_transmit_bytes_total", transmit, vm=vm, device="eth0", instance=f"{vm}:9100", job="node"))
    lines.extend(metric_family("node_network_receive_bytes_total", "counter", "Network bytes received.", receive_samples))
    lines.extend(metric_family("node_network_transmit_bytes_total", "counter", "Network bytes transmitted.", transmit_samples))

    request_samples = []
    latency_sum_samples = []
    bucket_samples = []
    inflight_samples = []
    for vm in ("vm-web-01", "vm-web-02"):
        for route in WEB_ROUTES:
            ok_rate = lambda moment, vm=vm, route=route: traffic_rps(vm, route, moment, incident_start_seconds) * (1.0 - error_ratio(vm, route, moment, incident_start_seconds))
            err_rate = lambda moment, vm=vm, route=route: traffic_rps(vm, route, moment, incident_start_seconds) * error_ratio(vm, route, moment, incident_start_seconds)
            request_samples.append(sample("http_requests_total", counter_value(ok_rate, t), vm=vm, route=route, method=METHOD, status="200", job="web"))
            request_samples.append(sample("http_requests_total", counter_value(err_rate, t), vm=vm, route=route, method=METHOD, status="500", job="web"))

            total_requests = counter_value(lambda moment, vm=vm, route=route: traffic_rps(vm, route, moment, incident_start_seconds), t)
            avg_latency = latency_seconds(vm, route, 0.50, t, incident_start_seconds)
            latency_sum_samples.append(sample("http_request_duration_seconds_sum", total_requests * avg_latency, vm=vm, route=route, method=METHOD, job="web"))
            latency_sum_samples.append(sample("http_request_duration_seconds_count", total_requests, vm=vm, route=route, method=METHOD, job="web"))
            inflight = traffic_rps(vm, route, t, incident_start_seconds) * latency_seconds(vm, route, 0.70, t, incident_start_seconds)
            inflight_samples.append(sample("http_inflight_requests", inflight, vm=vm, route=route, method=METHOD, job="web"))
            for bucket in HISTOGRAM_BUCKETS:
                bucket_samples.append(sample("http_request_duration_seconds_bucket", histogram_bucket_count(vm, route, bucket, t, incident_start_seconds), vm=vm, route=route, method=METHOD, le=str(bucket), job="web"))
            bucket_samples.append(sample("http_request_duration_seconds_bucket", total_requests, vm=vm, route=route, method=METHOD, le="+Inf", job="web"))

    lines.extend(metric_family("http_requests_total", "counter", "HTTP requests by route, status, and VM.", request_samples))
    lines.extend(metric_family("http_request_duration_seconds", "histogram", "HTTP request duration histogram.", [*bucket_samples, *latency_sum_samples]))
    lines.extend(metric_family("http_inflight_requests", "gauge", "Current in-flight HTTP requests.", inflight_samples))

    return "\n".join(lines) + "\n"


def render_openmetrics_history(start_timestamp: int, total_seconds: int, step_seconds: int, incident_start_seconds: int) -> str:
    lines: list[str] = []
    metadata_written = False
    for elapsed in range(0, total_seconds + 1, step_seconds):
        timestamp_seconds = start_timestamp + elapsed
        for line in render_prometheus_metrics(elapsed, incident_start_seconds).splitlines():
            if line.startswith("# HELP") or line.startswith("# TYPE"):
                if not metadata_written:
                    lines.append(line)
                continue
            if line:
                lines.append(f"{line} {timestamp_seconds}")
        metadata_written = True
    lines.append("# EOF")
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Write historical OpenMetrics samples for the Observability Analyst local demo stack."
    )
    parser.add_argument("--output", default=os.getenv("OPENMETRICS_OUTPUT", "/demo/history.openmetrics"))
    parser.add_argument("--hours", type=int, default=int(os.getenv("HISTORY_HOURS", str(DEFAULT_HISTORY_HOURS))))
    parser.add_argument("--step-seconds", type=int, default=int(os.getenv("HISTORY_STEP_SECONDS", str(DEFAULT_STEP_SECONDS))))
    parser.add_argument("--incident-duration-seconds", type=int, default=int(os.getenv("INCIDENT_DURATION_SECONDS", str(DEFAULT_INCIDENT_DURATION_SECONDS))))
    parser.add_argument("--future-seconds", type=int, default=int(os.getenv("HISTORY_FUTURE_SECONDS", str(DEFAULT_FUTURE_SECONDS))))
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
        render_openmetrics_history(
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
