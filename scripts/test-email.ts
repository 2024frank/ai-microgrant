import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
import { sendReviewNotification } from '../src/lib/email';

const to = process.argv[2] || 'fkusiapp@gmail.com';

console.log(`Sending test email to ${to} via ${process.env.SMTP_USER}...`);

sendReviewNotification({
  reviewerEmail:  to,
  reviewerName:   'Frank',
  pendingCount:   5,
  sources:        [{ name: 'FAVA', count: 3 }, { name: 'Apollo Theater', count: 2 }],
  oldestDate:     '2 days ago',
  previewEvents:  [
    { title: 'Class: Beginning Ceramic Wheel Throwing', source: 'FAVA' },
    { title: 'Toy Story 5', source: 'Apollo Theater' },
  ],
}).then(info => {
  console.log('✓ Sent:', JSON.stringify(info));
}).catch(err => {
  console.error('✗ Failed:', err.message);
  process.exit(1);
});
