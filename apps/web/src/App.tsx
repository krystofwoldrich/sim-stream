import { SimulatorStream } from "@sim-stream/client";

const SERVER_URL = "http://localhost:3100";

export function App() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 16,
        padding: 32,
      }}
    >
      <h1 style={{ fontSize: 20, fontWeight: 500, opacity: 0.7 }}>
        sim-stream
      </h1>
      <SimulatorStream
        url={SERVER_URL}
        device="default"
        style={{ width: "min(37vh, 90vw)" }}
      />
    </div>
  );
}
