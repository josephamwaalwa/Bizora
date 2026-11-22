import React, { useState, useRef, useEffect } from 'react';
import { useApp } from '../../context/AppContext';
import { useCloudAuth } from '../../hooks/useCloudAuth';
import { useTheme } from '../../hooks/useTheme';
import type { ThemeMode } from '../../utils/theme';
import {
  Search,
  Bell,
  Menu,
  Plus,
  FileText,
  Receipt,
  UserPlus,
  RefreshCw,
  Building,
  LogOut,
  Sun,
  Moon,
  Monitor,
  Check,
} from 'lucide-react';
import { Button } from '../common/Button';
import { formatRelativeTime } from '../../utils/formatters';
import { BusinessAvatar } from '../common/BusinessAvatar';

interface TopBarProps {
  onOpenMobileSidebar: () => void;
}

const THEME_OPTIONS: { id: ThemeMode; label: string; icon: React.ReactNode }[] = [
  { id: 'light', label: 'Light', icon: <Sun className="h-4 w-4" strokeWidth={1.75} /> },
  { id: 'dark', label: 'Dark', icon: <Moon className="h-4 w-4" strokeWidth={1.75} /> },
  { id: 'system', label: 'System', icon: <Monitor className="h-4 w-4" strokeWidth={1.75} /> },
];

export const TopBar: React.FC<TopBarProps> = ({ onOpenMobileSidebar }) => {
  const {
    activeView,
    setActiveView,
    searchQuery,
    setSearchQuery,
    businessProfile,
    activities,
    quotations,
    invoices,
    openDocumentPreview,
    resetToDemoData,
    showConfirmDialog,
  } = useApp();

  const { authState, signOut } = useCloudAuth();
  const { theme, setTheme } = useTheme();

  const [showThemeMenu, setShowThemeMenu] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showQuickCreate, setShowQuickCreate] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);

  const themeRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const quickRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (themeRef.current && !themeRef.current.contains(e.target as Node)) {
        setShowThemeMenu(false);
      }
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setShowNotifications(false);
      }
      if (quickRef.current && !quickRef.current.contains(e.target as Node)) {
        setShowQuickCreate(false);
      }
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setShowProfileMenu(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowThemeMenu(false);
        setShowNotifications(false);
        setShowQuickCreate(false);
        setShowProfileMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const viewLabel: Record<string, string> = {
    dashboard: 'Overview',
    quotations: 'Quotations',
    'quotation-new': 'New quotation',
    'quotation-edit': 'Edit quotation',
    invoices: 'Invoices',
    'invoice-new': 'New invoice',
    'invoice-edit': 'Edit invoice',
    clients: 'Clients',
    'client-detail': 'Client',
    settings: 'Settings',
  };

  const handleNotificationClick = (referenceId?: string, activityType?: string) => {
    if (!referenceId) return;
    setShowNotifications(false);

    const trimmed = referenceId.trim();
    const matchedQuoteById = quotations.find((item) => item.id === trimmed);
    if (matchedQuoteById) {
      openDocumentPreview('quote', matchedQuoteById);
      return;
    }

    const matchedInvoiceById = invoices.find((item) => item.id === trimmed);
    if (matchedInvoiceById) {
      openDocumentPreview('invoice', matchedInvoiceById);
      return;
    }

    const normalized = trimmed.toLowerCase();
    if (activityType?.startsWith('quote') || trimmed.startsWith('quo_') || trimmed.startsWith('QUO-')) {
      const q = quotations.find((item) => item.quotationNumber.trim().toLowerCase() === normalized);
      if (q) openDocumentPreview('quote', q);
    } else if (
      activityType?.startsWith('invoice') ||
      activityType === 'payment_recorded' ||
      trimmed.startsWith('inv_') ||
      trimmed.startsWith('INV-')
    ) {
      const inv = invoices.find((item) => item.invoiceNumber.trim().toLowerCase() === normalized);
      if (inv) openDocumentPreview('invoice', inv);
    }
  };

  const renderActiveThemeIcon = () => {
    if (theme === 'light') return <Sun className="h-[18px] w-[18px]" strokeWidth={1.75} />;
    if (theme === 'dark') return <Moon className="h-[18px] w-[18px]" strokeWidth={1.75} />;
    return <Monitor className="h-[18px] w-[18px]" strokeWidth={1.75} />;
  };

  return (
    <header className="topbar sticky top-0 z-30 flex h-16 w-full items-center justify-between gap-4 border-b border-line bg-paper px-5 sm:px-8 lg:px-12 xl:px-16">
      <div className="flex min-w-0 items-center gap-3">
        <button
          onClick={onOpenMobileSidebar}
          className="lg:hidden p-1 text-ink-secondary hover:text-ink"
          aria-label="Open navigation"
        >
          <Menu className="w-5 h-5" />
        </button>
        <p className="truncate text-[15px] text-ink-secondary lg:hidden">{viewLabel[activeView] || 'Bizora'}</p>
      </div>

      <div className="hidden md:flex flex-1 max-w-md">
        <div className="relative w-full">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search documents or clients"
            className="field search-field"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[13px] text-ink-muted hover:text-ink"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 sm:gap-3">
        <div className="relative" ref={quickRef}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setShowQuickCreate(!showQuickCreate);
              setShowThemeMenu(false);
              setShowNotifications(false);
              setShowProfileMenu(false);
            }}
            leftIcon={<Plus className="w-4 h-4" />}
          >
            <span className="hidden sm:inline">New</span>
          </Button>

          {showQuickCreate && (
            <div className="absolute right-0 z-50 mt-2 w-52 border border-line bg-surface py-1 shadow-modal">
              <button
                onClick={() => {
                  setActiveView('quotation-new');
                  setShowQuickCreate(false);
                }}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] text-ink hover:bg-paper-sunken"
              >
                <FileText className="h-4 w-4 text-ink-muted" />
                Quotation
              </button>
              <button
                onClick={() => {
                  setActiveView('invoice-new');
                  setShowQuickCreate(false);
                }}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] text-ink hover:bg-paper-sunken"
              >
                <Receipt className="h-4 w-4 text-ink-muted" />
                Invoice
              </button>
              <button
                onClick={() => {
                  setActiveView('clients');
                  setShowQuickCreate(false);
                }}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] text-ink hover:bg-paper-sunken"
              >
                <UserPlus className="h-4 w-4 text-ink-muted" />
                Client
              </button>
            </div>
          )}
        </div>

        <div className="relative" ref={themeRef}>
          <button
            type="button"
            onClick={() => {
              setShowThemeMenu(!showThemeMenu);
              setShowNotifications(false);
              setShowQuickCreate(false);
              setShowProfileMenu(false);
            }}
            className="relative flex h-10 w-10 items-center justify-center text-ink-secondary transition-colors hover:text-ink"
            title={`Theme: ${theme.charAt(0).toUpperCase() + theme.slice(1)}`}
            aria-label="Theme"
            aria-expanded={showThemeMenu}
            aria-haspopup="menu"
          >
            {renderActiveThemeIcon()}
          </button>

          {showThemeMenu && (
            <div
              role="menu"
              aria-label="Theme options"
              className="absolute right-0 z-50 mt-2 w-40 border border-line bg-surface py-1 shadow-modal"
            >
              {THEME_OPTIONS.map((option) => {
                const isSelected = theme === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isSelected}
                    onClick={() => {
                      setTheme(option.id);
                      setShowThemeMenu(false);
                    }}
                    className={`flex w-full items-center justify-between gap-2 px-3.5 py-2 text-left text-[14px] transition-colors ${
                      isSelected
                        ? 'bg-paper-sunken font-medium text-ink'
                        : 'text-ink-secondary hover:bg-paper-sunken hover:text-ink'
                    }`}
                  >
                    <span className="flex items-center gap-2.5">
                      <span className={isSelected ? 'text-indigo-500' : 'text-ink-muted'}>{option.icon}</span>
                      <span>{option.label}</span>
                    </span>
                    {isSelected && <Check className="h-3.5 w-3.5 text-indigo-500" strokeWidth={2.25} />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="relative" ref={notifRef}>
          <button
            onClick={() => {
              setShowNotifications(!showNotifications);
              setShowThemeMenu(false);
              setShowQuickCreate(false);
              setShowProfileMenu(false);
            }}
            className="relative flex h-10 w-10 items-center justify-center text-ink-secondary hover:text-ink"
            title="Activity"
            aria-label="Activity"
          >
            <Bell className="h-[18px] w-[18px]" strokeWidth={1.75} />
            {activities.length > 0 && (
              <span className="absolute right-2 top-2 h-1.5 w-1.5 bg-indigo-500" />
            )}
          </button>

          {showNotifications && (
            <div className="absolute right-0 z-50 mt-2 w-[22rem] border border-line bg-surface shadow-modal">
              <div className="flex items-baseline justify-between border-b border-line px-5 py-4">
                <span className="text-[16px] font-medium text-ink">Activity</span>
                <span className="text-[13px] text-ink-muted">{activities.length} records</span>
              </div>

              <div className="max-h-96 overflow-y-auto">
                {activities.length === 0 ? (
                  <div className="px-5 py-8 text-[15px] text-ink-secondary">No recorded events.</div>
                ) : (
                  activities.slice(0, 6).map((act) => (
                    <div
                      key={act.id}
                      onClick={() => handleNotificationClick(act.referenceId, act.type)}
                      className={`border-b border-line px-5 py-4 last:border-b-0 ${
                        act.referenceId ? 'cursor-pointer hover:bg-paper-sunken' : ''
                      }`}
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="truncate text-[15px] font-medium text-ink">{act.title}</p>
                        <span className="shrink-0 text-[13px] text-ink-muted">
                          {formatRelativeTime(act.timestamp)}
                        </span>
                      </div>
                      <p className="mt-1 text-[14px] leading-snug text-ink-secondary">{act.description}</p>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        <div className="relative" ref={profileRef}>
          <button
            onClick={() => {
              setShowProfileMenu(!showProfileMenu);
              setShowThemeMenu(false);
              setShowNotifications(false);
              setShowQuickCreate(false);
            }}
            className="flex items-center gap-3 py-1 pl-1"
            title={businessProfile.name}
          >
            <span className="hidden max-w-[200px] truncate text-[15px] text-ink sm:inline">
              {businessProfile.name}
            </span>
            <BusinessAvatar
              name={businessProfile.name}
              logoUrl={businessProfile.logoUrl}
              size={38}
              tone="light"
            />
          </button>

          {showProfileMenu && (
            <div className="absolute right-0 z-50 mt-2 w-64 border border-line bg-surface py-1 shadow-modal">
              <div className="border-b border-line px-4 py-3">
                <p className="truncate text-[15px] font-medium text-ink">{businessProfile.name}</p>
                <p className="truncate text-[13px] text-ink-secondary">
                  {authState.session?.email || businessProfile.email}
                </p>
              </div>
              <button
                onClick={() => {
                  setActiveView('settings');
                  setShowProfileMenu(false);
                }}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] text-ink hover:bg-paper-sunken"
              >
                <Building className="h-4 w-4 text-ink-muted" />
                Business settings
              </button>
              <button
                onClick={() => {
                  setShowProfileMenu(false);
                  showConfirmDialog({
                    title: 'Restore demo data?',
                    message:
                      'This will reset sample Namibian agency data (Kalahari Creative Studio) for testing and exploring Bizora.',
                    confirmLabel: 'Restore demo data',
                    onConfirm: resetToDemoData,
                  });
                }}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] text-ink hover:bg-paper-sunken"
              >
                <RefreshCw className="h-4 w-4 text-ink-muted" />
                Restore demo data
              </button>
              <div className="my-1 border-t border-line" />
              <button
                type="button"
                onClick={() => {
                  setShowProfileMenu(false);
                  void signOut();
                }}
                data-testid="topbar-signout-button"
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] text-ink hover:bg-paper-sunken"
              >
                <LogOut className="h-4 w-4 text-ink-muted" />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
