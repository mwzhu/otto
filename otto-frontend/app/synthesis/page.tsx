import { Suspense } from "react";
import SynthesisClient from "./SynthesisClient";

export default function SynthesisPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-canvas" />}>
      <SynthesisClient />
    </Suspense>
  );
}
