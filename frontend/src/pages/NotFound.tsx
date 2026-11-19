import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { Card, Empty } from '../components/ui';

export function NotFound() {
  return (
    <Card>
      <Empty icon={Compass} title="There is no screen at this address" action={<Link className="btn btn--primary btn--go" to="/">Go to the overview</Link>}>
        The link may be old, or the page was moved.
      </Empty>
    </Card>
  );
}
