import React, { useState } from 'react';
import type { BusinessProfile } from '../../types';
import { getLogoOptions } from '../../utils/logo';

interface DocumentLogoProps {
  business: BusinessProfile;
  maxWidth?: number;
  maxHeight?: number;
  className?: string;
}

export const DocumentLogo: React.FC<DocumentLogoProps> = ({
  business,
  maxWidth,
  maxHeight = 52,
  className = '',
}) => {
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null);
  const logo = getLogoOptions(business);
  const showLogo = Boolean(business.logoUrl && failedLogoUrl !== business.logoUrl);

  if (!showLogo) return null;

  const resolvedMaxWidth = maxWidth ?? Math.min(Math.max(logo.size, 44), 140);

  return (
    <div
      className={`document-logo ${className}`.trim()}
      style={{
        maxWidth: `${resolvedMaxWidth}px`,
        maxHeight: `${maxHeight}px`,
      }}
    >
      <img
        src={business.logoUrl}
        alt={`${business.name} logo`}
        onError={() => setFailedLogoUrl(business.logoUrl)}
        style={{
          maxWidth: `${resolvedMaxWidth}px`,
          maxHeight: `${maxHeight}px`,
        }}
      />
    </div>
  );
};
