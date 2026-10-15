import type { ArmId } from '@/features/lab/types';
import { ARM_COLOR, ARM_LABEL } from './armColors';
import s from './era3.module.css';

/** Arm label with its colour dot, for table cells and lists. */
export function ArmName({ arm }: { arm: ArmId }) {
  return (
    <>
      <span className={s.dot} style={{ background: ARM_COLOR[arm] }} aria-hidden />
      {ARM_LABEL[arm]}
    </>
  );
}
