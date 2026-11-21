import React from 'react';
import { Mail, Phone, User } from 'lucide-react';
import type { ParentProfile } from '@/types/api';

interface ProfileCardProps {
  profile: ParentProfile;
}

export function ProfileCard({ profile }: ProfileCardProps) {
  return (
    // The testid stays stable -- a connection id is a server-generated cuid,
    // so a suffixed one is unguessable from a test and amounts to dropping
    // the hook. Per-card selectability comes from the data attribute instead:
    // `[data-testid="profile-card"][data-connection-id="..."]`, or
    // `.filter({ has: ... })` over the stable one.
    <div
      data-testid="profile-card"
      data-connection-id={profile.householdConnectionId}
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
          {/*
            The children THIS school lists. The name above used to carry one of
            them in brackets -- the creating credential's -- so both of a
            two-school parent's cards named the same child. Nothing renders
            while a school's first roster sync is pending: no children line is
            honest about not knowing yet, "ללא ילדים" would not be.
          */}
          {profile.children.length > 0 && (
            <p data-testid="profile-card-children" className="text-xs text-muted-foreground">
              {profile.children
                .map((child) => `${child.fullName} ${child.classCode}${child.classNum}`)
                .join(', ')}
            </p>
          )}
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
