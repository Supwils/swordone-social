import { Navigate, useLocation } from 'react-router-dom';
import { LabV2Page, v1DeepLink } from '@/features/lab';

/** `/lab` is lab v2; an old v1 deep link is sent to `/lab/v1` with its query intact. */
export default function LabRoute() {
  const { search } = useLocation();
  const target = v1DeepLink(search);
  return target ? <Navigate to={target} replace /> : <LabV2Page />;
}
