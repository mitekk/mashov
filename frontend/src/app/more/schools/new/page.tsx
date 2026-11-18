import type { Metadata } from 'next';
import AddSchoolPageClient from './AddSchoolPageClient';

export const metadata: Metadata = {
  title: 'הוספת בית ספר',
  alternates: {
    canonical: '/more/schools/new',
  },
  robots: {
    index: false,
    follow: false,
  },
};

export default function AddSchoolPage() {
  return <AddSchoolPageClient />;
}
