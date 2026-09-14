export interface Service {
  id: string;
  name: string;
  duration: number;
  price: number;
  description: string;
  active: boolean;
}
export interface Staff {
  id: string;
  name: string;
  bio: string;
  active: boolean;
  services: string[];
}
export interface Hour {
  id: string;
  staff_id: string;
  weekday: number;
  start_minute: number;
  end_minute: number;
}
export interface Catalog {
  services: Service[];
  staff: Staff[];
  hours: Hour[];
}
export interface Slot {
  startsAt: string;
  endsAt: string;
  label: string;
  staffId: string;
  staffName: string;
}
export interface Notification {
  id: string;
  kind: string;
  state: string;
  message_id: string | null;
  reference?: string;
  created_at: string;
  delivered_at: string | null;
}
export interface Appointment {
  id: string;
  reference: string;
  serviceId: string;
  staffId: string;
  serviceName: string;
  staffName: string;
  duration: number;
  price: number;
  startsAt: string;
  endsAt: string;
  name: string;
  email: string;
  phone: string;
  note: string;
  status: string;
  version: number;
  reminderAt: string | null;
  createdAt: string;
  managementKey?: string;
  notifications?: Notification[];
  events?: {
    kind: string;
    actor: string;
    created_at: string;
    detail: Record<string, string>;
  }[];
}
export interface Session {
  csrf: string;
  admin: boolean;
  expiresAt: string;
  timezone: string;
  today: string;
}
export interface Block {
  id: string;
  staff_id: string;
  starts_at: string;
  ends_at: string;
  reason: string;
}
