import React from 'react';
import { Mail, Phone, User } from 'lucide-react';
import type { ParentProfile } from '@/types/api';

interface ProfileCardProps {
  profile: ParentProfile;
}

export function ProfileCard({ profile }: ProfileCardProps) {
  return (
    // The testid is suffixed with the connection id because a two-school
    // household renders one card per school, and N identical testids break
    // Playwright's strict mode for anything that later selects one.
    <div
      data-testid={`profile-card-${profile.householdConnectionId}`}
      className="card-base p-4 space-y-3"
    >
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
          <User className="w-5 h-5 text-primary" />
        </div>
        <div>
          <p className="text-sm font-semibold text-foreground">{profile.displayName}</p>
          <p className="text-xs text-muted-foreground">
            {profile.schoolName} · {profile.schoolYear}
          </p>
        </div>
      </div>

      {profile.email && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Mail className="w-4 h-4 flex-shrink-0" />
          <span dir="ltr">{profile.email}</span>
        </div>
      )}

      {profile.cellphone && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Phone className="w-4 h-4 flex-shrink-0" />
          <span dir="ltr">{profile.cellphone}</span>
        </div>
      )}
    </div>
  );
}
