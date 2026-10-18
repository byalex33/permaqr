import { useEffect, useState } from "preact/hooks";
import type { AnalyticsBucket, AnalyticsResponse } from "../../shared/types";
import { api } from "./api";

const RANGES = [
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" },
  { id: "all", label: "All" },
] as const;

export function Analytics({ codeId }: { codeId: string }) {
  const [range, setRange] = useState<(typeof RANGES)[number]["id"]>("30d");
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setError("");
    api<AnalyticsResponse>(`/api/codes/${codeId}/analytics?range=${range}`)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [codeId, range]);

  return (
    <div class="analytics">
      <div class="range-row">
        {RANGES.map((item) => (
          <button
            key={item.id}
            type="button"
            class={item.id === range ? "chip on" : "chip"}
            onClick={() => setRange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {error ? <p class="error">{error}</p> : null}
      {data ? (
        <>
          <div class="stat-row">
            <p>
              <strong>{data.total.toLocaleString()}</strong>
              <span>scans, all time</span>
            </p>
            <p>
              <strong>{data.ranged_total.toLocaleString()}</strong>
              <span>in this range</span>
            </p>
          </div>
          {data.total === 0 ? (
            <p class="empty-copy">No scans yet. Open the short link, or print the code and point a phone at it.</p>
          ) : (
            <>
              <Chart series={data.series} />
              <div class="split">
                <Buckets title="Countries" buckets={data.countries} />
                <Buckets title="Devices" buckets={data.devices} />
              </div>
            </>
          )}
        </>
      ) : (
        <p class="hint">Loading scans…</p>
      )}
    </div>
  );
}

function Chart({ series }: { series: AnalyticsResponse["series"] }) {
  const width = 640;
  const height = 180;
  const max = Math.max(1, ...series.map((point) => point.count));
  const gap = 4;
  const barWidth = series.length > 0 ? (width - gap * (series.length - 1)) / series.length : width;
  const labelEvery = series.length > 18 ? Math.ceil(series.length / 8) : series.length > 10 ? 2 : 1;
  return (
    <svg class="chart" viewBox={`0 0 ${width} ${height + 28}`} role="img" aria-label="Scans over time">
      {series.map((point, index) => {
        const barHeight = (point.count / max) * (height - 8);
        const x = index * (barWidth + gap);
        const y = height - barHeight;
        return (
          <g key={point.date}>
            <rect x={x} y={y} width={Math.max(barWidth, 1)} height={barHeight} rx="3" fill="#e23b2a" />
            {index % labelEvery === 0 ? (
              <text x={x} y={height + 18} fill="#6e665c" fontSize="11">
                {formatDay(point.date)}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function Buckets({ title, buckets }: { title: string; buckets: AnalyticsBucket[] }) {
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  return (
    <section>
      <h3>{title}</h3>
      {buckets.length === 0 ? <p class="hint">Nothing in this range.</p> : null}
      <ul class="buckets">
        {buckets.map((bucket) => (
          <li key={bucket.label}>
            <span>{bucket.label}</span>
            <span class="track">
              <span style={{ width: `${(bucket.count / max) * 100}%` }} />
            </span>
            <span>{bucket.count}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatDay(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  if (!year || !month || !day) return iso;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
