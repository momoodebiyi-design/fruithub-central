export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      announcements: {
        Row: {
          body: string
          created_at: string
          created_by: string | null
          id: string
          title: string
        }
        Insert: {
          body: string
          created_at?: string
          created_by?: string | null
          id?: string
          title: string
        }
        Update: {
          body?: string
          created_at?: string
          created_by?: string | null
          id?: string
          title?: string
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          action: string
          created_at: string
          entity: string
          entity_id: string | null
          id: string
          new_value: Json | null
          previous_value: Json | null
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          entity: string
          entity_id?: string | null
          id?: string
          new_value?: Json | null
          previous_value?: Json | null
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          entity?: string
          entity_id?: string | null
          id?: string
          new_value?: Json | null
          previous_value?: Json | null
          user_id?: string | null
        }
        Relationships: []
      }
      clients: {
        Row: {
          address: string | null
          contact_name: string | null
          created_at: string
          email: string | null
          id: string
          is_active: boolean
          name: string
          notes: string | null
          phone: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          contact_name?: string | null
          created_at?: string
          email?: string | null
          id?: string
          is_active?: boolean
          name: string
          notes?: string | null
          phone?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          contact_name?: string | null
          created_at?: string
          email?: string | null
          id?: string
          is_active?: boolean
          name?: string
          notes?: string | null
          phone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      dispatch_lines: {
        Row: {
          created_at: string
          dispatch_id: string
          id: string
          item_id: string
          notes: string | null
          quantity_dispatched: number
          quantity_returned: number
        }
        Insert: {
          created_at?: string
          dispatch_id: string
          id?: string
          item_id: string
          notes?: string | null
          quantity_dispatched: number
          quantity_returned?: number
        }
        Update: {
          created_at?: string
          dispatch_id?: string
          id?: string
          item_id?: string
          notes?: string | null
          quantity_dispatched?: number
          quantity_returned?: number
        }
        Relationships: [
          {
            foreignKeyName: "dispatch_lines_dispatch_id_fkey"
            columns: ["dispatch_id"]
            isOneToOne: false
            referencedRelation: "dispatches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatch_lines_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
        ]
      }
      dispatches: {
        Row: {
          client_id: string | null
          created_at: string
          dispatched_at: string
          dispatched_by: string | null
          id: string
          invoice_number: string | null
          invoice_url: string | null
          notes: string | null
          received_at: string | null
          received_by: string | null
          reference: string
          shop_id: string | null
          status: Database["public"]["Enums"]["dispatch_status"]
          updated_at: string
          vehicle: string | null
        }
        Insert: {
          client_id?: string | null
          created_at?: string
          dispatched_at?: string
          dispatched_by?: string | null
          id?: string
          invoice_number?: string | null
          invoice_url?: string | null
          notes?: string | null
          received_at?: string | null
          received_by?: string | null
          reference: string
          shop_id?: string | null
          status?: Database["public"]["Enums"]["dispatch_status"]
          updated_at?: string
          vehicle?: string | null
        }
        Update: {
          client_id?: string | null
          created_at?: string
          dispatched_at?: string
          dispatched_by?: string | null
          id?: string
          invoice_number?: string | null
          invoice_url?: string | null
          notes?: string | null
          received_at?: string | null
          received_by?: string | null
          reference?: string
          shop_id?: string | null
          status?: Database["public"]["Enums"]["dispatch_status"]
          updated_at?: string
          vehicle?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "dispatches_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatches_dispatched_by_fkey"
            columns: ["dispatched_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatches_received_by_fkey"
            columns: ["received_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatches_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_batches: {
        Row: {
          batch_number: string
          expiry_date: string | null
          id: string
          item_id: string
          quantity: number
          received_at: string
        }
        Insert: {
          batch_number: string
          expiry_date?: string | null
          id?: string
          item_id: string
          quantity?: number
          received_at?: string
        }
        Update: {
          batch_number?: string
          expiry_date?: string | null
          id?: string
          item_id?: string
          quantity?: number
          received_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_batches_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_items: {
        Row: {
          category: Database["public"]["Enums"]["inventory_category"]
          created_at: string
          id: string
          is_active: boolean
          location: string | null
          min_level: number
          name: string
          notes: string | null
          purchase_cost: number
          quantity: number
          reorder_level: number
          sku: string
          supplier_id: string | null
          unit: string
          updated_at: string
        }
        Insert: {
          category: Database["public"]["Enums"]["inventory_category"]
          created_at?: string
          id?: string
          is_active?: boolean
          location?: string | null
          min_level?: number
          name: string
          notes?: string | null
          purchase_cost?: number
          quantity?: number
          reorder_level?: number
          sku: string
          supplier_id?: string | null
          unit?: string
          updated_at?: string
        }
        Update: {
          category?: Database["public"]["Enums"]["inventory_category"]
          created_at?: string
          id?: string
          is_active?: boolean
          location?: string | null
          min_level?: number
          name?: string
          notes?: string | null
          purchase_cost?: number
          quantity?: number
          reorder_level?: number
          sku?: string
          supplier_id?: string | null
          unit?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_items_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_movements: {
        Row: {
          batch_id: string | null
          created_at: string
          dispatch_id: string | null
          from_client_id: string | null
          from_shop_id: string | null
          id: string
          item_id: string
          performed_by: string | null
          quantity: number
          reason: string | null
          related_production_batch: string | null
          to_client_id: string | null
          to_shop_id: string | null
          type: Database["public"]["Enums"]["movement_type"]
        }
        Insert: {
          batch_id?: string | null
          created_at?: string
          dispatch_id?: string | null
          from_client_id?: string | null
          from_shop_id?: string | null
          id?: string
          item_id: string
          performed_by?: string | null
          quantity: number
          reason?: string | null
          related_production_batch?: string | null
          to_client_id?: string | null
          to_shop_id?: string | null
          type: Database["public"]["Enums"]["movement_type"]
        }
        Update: {
          batch_id?: string | null
          created_at?: string
          dispatch_id?: string | null
          from_client_id?: string | null
          from_shop_id?: string | null
          id?: string
          item_id?: string
          performed_by?: string | null
          quantity?: number
          reason?: string | null
          related_production_batch?: string | null
          to_client_id?: string | null
          to_shop_id?: string | null
          type?: Database["public"]["Enums"]["movement_type"]
        }
        Relationships: [
          {
            foreignKeyName: "inventory_movements_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "inventory_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_movements_dispatch_id_fkey"
            columns: ["dispatch_id"]
            isOneToOne: false
            referencedRelation: "dispatches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_movements_from_client_id_fkey"
            columns: ["from_client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_movements_from_shop_id_fkey"
            columns: ["from_shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_movements_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_movements_to_client_id_fkey"
            columns: ["to_client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_movements_to_shop_id_fkey"
            columns: ["to_shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string | null
          created_at: string
          id: string
          level: Database["public"]["Enums"]["notification_level"]
          link: string | null
          read_at: string | null
          title: string
          user_id: string | null
        }
        Insert: {
          body?: string | null
          created_at?: string
          id?: string
          level?: Database["public"]["Enums"]["notification_level"]
          link?: string | null
          read_at?: string | null
          title: string
          user_id?: string | null
        }
        Update: {
          body?: string | null
          created_at?: string
          id?: string
          level?: Database["public"]["Enums"]["notification_level"]
          link?: string | null
          read_at?: string | null
          title?: string
          user_id?: string | null
        }
        Relationships: []
      }
      production_batches: {
        Row: {
          batch_number: string
          created_at: string
          id: string
          produced_at: string
          product_item_id: string
          qc_notes: string | null
          quantity_produced: number
          staff_id: string | null
          status: Database["public"]["Enums"]["batch_status"]
        }
        Insert: {
          batch_number: string
          created_at?: string
          id?: string
          produced_at?: string
          product_item_id: string
          qc_notes?: string | null
          quantity_produced: number
          staff_id?: string | null
          status?: Database["public"]["Enums"]["batch_status"]
        }
        Update: {
          batch_number?: string
          created_at?: string
          id?: string
          produced_at?: string
          product_item_id?: string
          qc_notes?: string | null
          quantity_produced?: number
          staff_id?: string | null
          status?: Database["public"]["Enums"]["batch_status"]
        }
        Relationships: [
          {
            foreignKeyName: "production_batches_product_item_id_fkey"
            columns: ["product_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
        ]
      }
      production_consumption: {
        Row: {
          id: string
          item_id: string
          production_batch_id: string
          quantity_used: number
        }
        Insert: {
          id?: string
          item_id: string
          production_batch_id: string
          quantity_used: number
        }
        Update: {
          id?: string
          item_id?: string
          production_batch_id?: string
          quantity_used?: number
        }
        Relationships: [
          {
            foreignKeyName: "production_consumption_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "production_consumption_production_batch_id_fkey"
            columns: ["production_batch_id"]
            isOneToOne: false
            referencedRelation: "production_batches"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          department: string | null
          email: string
          full_name: string | null
          id: string
          is_active: boolean
          phone: string | null
          shop_id: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          department?: string | null
          email: string
          full_name?: string | null
          id: string
          is_active?: boolean
          phone?: string | null
          shop_id?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          department?: string | null
          email?: string
          full_name?: string | null
          id?: string
          is_active?: boolean
          phone?: string | null
          shop_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
        ]
      }
      shop_assortments: {
        Row: {
          created_at: string
          id: string
          item_id: string
          shop_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          item_id: string
          shop_id: string
        }
        Update: {
          created_at?: string
          id?: string
          item_id?: string
          shop_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shop_assortments_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_assortments_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
        ]
      }
      shop_stock_count_lines: {
        Row: {
          count_id: string
          created_at: string
          id: string
          item_id: string
          quantity_counted: number
        }
        Insert: {
          count_id: string
          created_at?: string
          id?: string
          item_id: string
          quantity_counted?: number
        }
        Update: {
          count_id?: string
          created_at?: string
          id?: string
          item_id?: string
          quantity_counted?: number
        }
        Relationships: [
          {
            foreignKeyName: "shop_stock_count_lines_count_id_fkey"
            columns: ["count_id"]
            isOneToOne: false
            referencedRelation: "shop_stock_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_stock_count_lines_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
        ]
      }
      shop_stock_counts: {
        Row: {
          count_date: string
          count_type: Database["public"]["Enums"]["stock_count_type"]
          created_at: string
          id: string
          notes: string | null
          shop_id: string
          status: Database["public"]["Enums"]["stock_count_status"]
          submitted_at: string | null
          submitted_by: string | null
          updated_at: string
        }
        Insert: {
          count_date: string
          count_type: Database["public"]["Enums"]["stock_count_type"]
          created_at?: string
          id?: string
          notes?: string | null
          shop_id: string
          status?: Database["public"]["Enums"]["stock_count_status"]
          submitted_at?: string | null
          submitted_by?: string | null
          updated_at?: string
        }
        Update: {
          count_date?: string
          count_type?: Database["public"]["Enums"]["stock_count_type"]
          created_at?: string
          id?: string
          notes?: string | null
          shop_id?: string
          status?: Database["public"]["Enums"]["stock_count_status"]
          submitted_at?: string | null
          submitted_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shop_stock_counts_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
        ]
      }
      shops: {
        Row: {
          contact_email: string | null
          contact_phone: string | null
          created_at: string
          id: string
          is_active: boolean
          location: string | null
          manager_id: string | null
          name: string
          notes: string | null
          updated_at: string
        }
        Insert: {
          contact_email?: string | null
          contact_phone?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          location?: string | null
          manager_id?: string | null
          name: string
          notes?: string | null
          updated_at?: string
        }
        Update: {
          contact_email?: string | null
          contact_phone?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          location?: string | null
          manager_id?: string | null
          name?: string
          notes?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shops_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_requests: {
        Row: {
          created_at: string
          destination_shop_id: string | null
          fulfilled_movement_id: string | null
          id: string
          item_id: string
          purpose: string
          quantity: number
          requested_by: string
          review_notes: string | null
          reviewed_at: string | null
          reviewer_id: string | null
          status: Database["public"]["Enums"]["stock_request_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          destination_shop_id?: string | null
          fulfilled_movement_id?: string | null
          id?: string
          item_id: string
          purpose: string
          quantity: number
          requested_by: string
          review_notes?: string | null
          reviewed_at?: string | null
          reviewer_id?: string | null
          status?: Database["public"]["Enums"]["stock_request_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          destination_shop_id?: string | null
          fulfilled_movement_id?: string | null
          id?: string
          item_id?: string
          purpose?: string
          quantity?: number
          requested_by?: string
          review_notes?: string | null
          reviewed_at?: string | null
          reviewer_id?: string | null
          status?: Database["public"]["Enums"]["stock_request_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_requests_destination_shop_id_fkey"
            columns: ["destination_shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_requests_fulfilled_movement_id_fkey"
            columns: ["fulfilled_movement_id"]
            isOneToOne: false
            referencedRelation: "inventory_movements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_requests_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_requests_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_requests_reviewer_id_fkey"
            columns: ["reviewer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      suppliers: {
        Row: {
          contact_name: string | null
          created_at: string
          email: string | null
          id: string
          name: string
          notes: string | null
          phone: string | null
        }
        Insert: {
          contact_name?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name: string
          notes?: string | null
          phone?: string | null
        }
        Update: {
          contact_name?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          notes?: string | null
          phone?: string | null
        }
        Relationships: []
      }
      user_invites: {
        Row: {
          accepted_at: string | null
          created_at: string
          department: string | null
          email: string
          expires_at: string
          full_name: string | null
          id: string
          invited_by: string | null
          role: Database["public"]["Enums"]["app_role"]
          token: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          department?: string | null
          email: string
          expires_at?: string
          full_name?: string | null
          id?: string
          invited_by?: string | null
          role: Database["public"]["Enums"]["app_role"]
          token?: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          department?: string | null
          email?: string
          expires_at?: string
          full_name?: string | null
          id?: string
          invited_by?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          token?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      approve_stock_request: {
        Args: { _notes?: string; _request_id: string }
        Returns: string
      }
      create_dispatch: {
        Args: {
          _client_id: string
          _invoice_number: string
          _invoice_url: string
          _lines: Json
          _notes: string
          _reference: string
          _shop_id: string
          _vehicle: string
        }
        Returns: string
      }
      has_any_role: {
        Args: {
          _roles: Database["public"]["Enums"]["app_role"][]
          _user_id: string
        }
        Returns: boolean
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      record_production: {
        Args: {
          _batch_number: string
          _consumption: Json
          _product_item_id: string
          _qc_notes?: string
          _quantity: number
        }
        Returns: string
      }
      record_shop_return: {
        Args: { _dispatch_id: string; _lines: Json; _reason: string }
        Returns: undefined
      }
      reject_stock_request: {
        Args: { _notes: string; _request_id: string }
        Returns: undefined
      }
      submit_shop_stock_count: {
        Args: { _count_id: string }
        Returns: undefined
      }
    }
    Enums: {
      app_role:
        | "super_admin"
        | "management"
        | "operations_manager"
        | "production"
        | "inventory_officer"
        | "procurement"
        | "admin"
        | "event_team"
        | "sales"
        | "readonly"
        | "shop_supervisor"
      batch_status:
        | "planned"
        | "in_progress"
        | "completed"
        | "qc_passed"
        | "qc_failed"
      customer_type: "retail" | "wholesale" | "outlet" | "online"
      dispatch_status:
        | "draft"
        | "dispatched"
        | "received"
        | "reconciled"
        | "cancelled"
      inventory_category:
        | "packaging"
        | "raw_material"
        | "consumable"
        | "finished_good"
        | "semi_finished"
      movement_type:
        | "stock_in"
        | "stock_out"
        | "transfer"
        | "adjustment"
        | "damaged"
        | "expired"
        | "wastage"
        | "production_consume"
        | "production_output"
        | "opening_balance"
        | "receipt"
        | "sale"
        | "adjustment_in"
        | "adjustment_out"
      notification_level: "info" | "warn" | "critical"
      purchase_order_status:
        | "draft"
        | "ordered"
        | "partial"
        | "received"
        | "cancelled"
      recipe_status: "draft" | "pending_approval" | "approved" | "retired"
      sales_order_status: "draft" | "confirmed" | "fulfilled" | "void"
      stock_count_status: "draft" | "submitted"
      stock_count_type: "opening" | "closing"
      stock_request_status:
        | "pending"
        | "approved"
        | "rejected"
        | "fulfilled"
        | "cancelled"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: [
        "super_admin",
        "management",
        "operations_manager",
        "production",
        "inventory_officer",
        "procurement",
        "admin",
        "event_team",
        "sales",
        "readonly",
        "shop_supervisor",
      ],
      batch_status: [
        "planned",
        "in_progress",
        "completed",
        "qc_passed",
        "qc_failed",
      ],
      customer_type: ["retail", "wholesale", "outlet", "online"],
      dispatch_status: [
        "draft",
        "dispatched",
        "received",
        "reconciled",
        "cancelled",
      ],
      inventory_category: [
        "packaging",
        "raw_material",
        "consumable",
        "finished_good",
        "semi_finished",
      ],
      movement_type: [
        "stock_in",
        "stock_out",
        "transfer",
        "adjustment",
        "damaged",
        "expired",
        "wastage",
        "production_consume",
        "production_output",
        "opening_balance",
        "receipt",
        "sale",
        "adjustment_in",
        "adjustment_out",
      ],
      notification_level: ["info", "warn", "critical"],
      purchase_order_status: [
        "draft",
        "ordered",
        "partial",
        "received",
        "cancelled",
      ],
      recipe_status: ["draft", "pending_approval", "approved", "retired"],
      sales_order_status: ["draft", "confirmed", "fulfilled", "void"],
      stock_count_status: ["draft", "submitted"],
      stock_count_type: ["opening", "closing"],
      stock_request_status: [
        "pending",
        "approved",
        "rejected",
        "fulfilled",
        "cancelled",
      ],
    },
  },
} as const
