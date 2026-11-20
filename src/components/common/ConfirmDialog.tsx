import React, { useState } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';
import { useApp } from '../../context/AppContext';

export const ConfirmDialog: React.FC = () => {
  const { confirmDialog, hideConfirmDialog } = useApp();
  const [isConfirming, setIsConfirming] = useState(false);

  const handleConfirm = async () => {
    if (isConfirming) return;
    setIsConfirming(true);
    try {
      await confirmDialog.onConfirm();
    } finally {
      setIsConfirming(false);
      hideConfirmDialog();
    }
  };

  const handleClose = () => {
    if (!isConfirming) {
      hideConfirmDialog();
    }
  };

  return (
    <Modal
      isOpen={confirmDialog.isOpen}
      onClose={handleClose}
      title={confirmDialog.title}
      maxWidth="md"
      showCloseButton={false}
    >
      <p className="text-[16px] leading-relaxed text-ink-secondary">{confirmDialog.message}</p>

      <div className="mt-8 flex items-center justify-end gap-3">
        <Button variant="secondary" size="md" onClick={handleClose} disabled={isConfirming}>
          {confirmDialog.cancelLabel || 'Cancel'}
        </Button>
        <Button
          variant={confirmDialog.isDestructive ? 'danger' : 'primary'}
          size="md"
          onClick={handleConfirm}
          disabled={isConfirming}
          isLoading={isConfirming}
        >
          {confirmDialog.confirmLabel || 'Confirm'}
        </Button>
      </div>
    </Modal>
  );
};
