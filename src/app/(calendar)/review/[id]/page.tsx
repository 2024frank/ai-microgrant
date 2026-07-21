import { ReviewDetailPage } from '@/components/ai-calendar/review-runs';
export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <ReviewDetailPage id={Number(id)}/>; }
