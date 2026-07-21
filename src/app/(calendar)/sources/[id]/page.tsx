import { SourceDetailPage } from '@/components/ai-calendar/dashboard-sources';
export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <SourceDetailPage id={Number(id)}/>; }
