import { Injectable, inject } from "@angular/core";
import { HttpClient, HttpErrorResponse } from "@angular/common/http";
import { firstValueFrom } from "rxjs";

export interface Membership {
  tenantId: string;
  name: string;
  role: string;
  branchId: string | null;
}
export interface User {
  id: string;
  email: string;
  displayName: string;
  memberships: Membership[];
}
export interface Branch {
  version: string;
  id: string;
  name: string;
  code: string;
  createdAt: string;
  timeZoneOverride: string | null;
  localeOverride: string | null;
  currencyOverride: string | null;
}
export interface Settings {
  version: string;
  displayName: string;
  timeZone: string;
  locale: string;
  currency: string;
  academicYearLabel: string;
}
export interface Audit {
  id: string;
  action: string;
  subject: string;
  occurredAt: string;
  actorId?: string;
  branchId?: string;
}
export interface Overview {
  branches: number;
  members: number;
  enabledModules: number;
  recentActivity: Audit[];
}
export interface Member {
  id: string;
  displayName: string;
  email: string;
  role: string;
  branchId: string | null;
  isActive: boolean;
}
export interface Module {
  module: string;
  enabled: boolean;
}

@Injectable({ providedIn: "root" })
export class Api {
  private http = inject(HttpClient);
  get<T>(path: string) {
    return firstValueFrom(this.http.get<T>(path));
  }
  post<T>(path: string, body: unknown = {}) {
    return firstValueFrom(this.http.post<T>(path, body));
  }
  put<T>(path: string, body: unknown) {
    return firstValueFrom(this.http.put<T>(path, body));
  }
}
export function errorMessage(e: unknown): string {
  if (e instanceof HttpErrorResponse) {
    if (e.status === 401)
      return "Please sign in again, or check your email and password.";
    if (e.status === 403) return "Your role does not allow this action.";
    if (e.status === 404)
      return "This resource is unavailable in your workspace.";
    if (e.status === 429)
      return "Too many attempts. Please wait a minute and try again.";
    if (e.status === 0 || e.status >= 500)
      return "The service is unavailable. Please try again shortly.";
    return e.error?.message ?? "The request could not be completed.";
  }
  return "Something went wrong. Please try again.";
}
