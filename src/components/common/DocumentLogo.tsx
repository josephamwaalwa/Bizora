import React, { useState } from 'react';
import type { BusinessProfile } from '../../types';

interface DocumentLogoProps {
  business: BusinessProfile;
  maxWidth?: number;
  maxHeight?: number;
  className?: string;
}

export const DocumentLogo: React.FC<DocumentLogoProps> = ({
  business,
  maxWidth = 112,
  maxHeight = 52,
  className = '',
}) => {
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null);
  const showLogo = Boolean(business.logoUrl && failedLogoUrl !== business.logoUrl);

  if (!showLogo) return null;

  return (
    <div
      className={`document-logo ${className}`.trim()}
      style={{
        maxWidth: `${maxWidth}px`,
        maxHeight: `${maxHeight}px`,
      }}
    >
      <img
        src={business.logoUrl}
        alt={`${business.name} logo`}
        onError={() => setFailedLogoUrl(business.logoUrl)}
        style={{
          maxWidth: `${maxWidth}px`,
          maxHeight: `${maxHeight}px`,
        }}
      />
    </div>
  );
};
