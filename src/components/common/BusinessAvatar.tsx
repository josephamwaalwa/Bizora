import React, { useState } from 'react';

interface BusinessAvatarProps {
  name: string;
  logoUrl?: string;
  size?: number;
  tone?: 'light' | 'dark';
  className?: string;
}

export const BusinessAvatar: React.FC<BusinessAvatarProps> = ({
  name,
  logoUrl,
  size = 40,
  tone = 'light',
  className = '',
}) => {
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null);
  const showLogo = Boolean(logoUrl && failedLogoUrl !== logoUrl);
  const initial = (name?.trim().charAt(0) || 'B').toUpperCase();

  return (
    <div
      className={`business-avatar business-avatar--${tone} ${className}`.trim()}
      style={{
        width: `${size}px`,
        height: `${size}px`,
      }}
      aria-label={`${name} avatar`}
    >
      {showLogo ? (
        <img
          src={logoUrl}
          alt={`${name} logo`}
          onError={() => setFailedLogoUrl(logoUrl || null)}
        />
      ) : (
        <span className="business-avatar-initial">{initial}</span>
      )}
    </div>
  );
};
