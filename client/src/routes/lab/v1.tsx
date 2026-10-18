import { LabPage, LabV1Banner } from '@/features/lab';

/** Today's lab, verbatim, at `/lab/v1` (Era 2 view, graph, Persona Bench). */
export default function LabV1Route() {
  return (
    <>
      <LabV1Banner />
      <LabPage />
    </>
  );
}
