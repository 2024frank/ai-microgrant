import EventsListPage from '@/components/EventsListPage';

export default function SubmittedEventsPage() {
  return (
    <EventsListPage
      status="submitted"
      title="Awaiting CommunityHub"
      emptyMsg="No submissions are waiting for CommunityHub moderation"
    />
  );
}
