import type { Metadata } from "next";

import { GuardianApprovalPage } from "../../../../../features/dashboard/guardian-approval";

export const metadata: Metadata = {
  title: "Recovery request · Scholium",
  description: "Approve or decline a recovery request for your account.",
};

type Params = Promise<{ id: string }>;

export default async function MeRecoveryRequestPage({ params }: { params: Params }) {
  const { id } = await params;
  return <GuardianApprovalPage requestId={id} />;
}
