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
      customers: {
        Row: {
          address: string | null
          code: string | null
          contact_name: string | null
          created_at: string
          email: string | null
          id: string
          is_active: boolean
          name: string
          notes: string | null
          phone: string | null
          type: Database["public"]["Enums"]["customer_type"]
          updated_at: string
        }
        Insert: {
          address?: string | null
          code?: string | null
          contact_name?: string | null
          created_at?: string
          email?: string | null
          id?: string
          is_active?: boolean
          name: string
          notes?: string | null
          phone?: string | null
          type?: Database["public"]["Enums"]["customer_type"]
          updated_at?: string
        }
        Update: {
          address?: string | null
          code?: string | null
          contact_name?: string | null
          created_at?: string
          email?: string | null
          id?: string
          is_active?: boolean
          name?: string
          notes?: string | null
          phone?: string | null
          type?: Database["public"]["Enums"]["customer_type"]
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
          {
            foreignKeyName: "dispatch_lines_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "v_item_stock"
            referencedColumns: ["item_id"]
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
          {
            foreignKeyName: "inventory_batches_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "v_item_stock"
            referencedColumns: ["item_id"]
          },
        ]
      }
      inventory_items: {
        Row: {
          aliases: string[] | null
          category: Database["public"]["Enums"]["inventory_category"]
          created_at: string
          default_location_id: string | null
          id: string
          import_notes: string | null
          is_active: boolean
          item_id: string | null
          location: string | null
          min_level: number
          name: string
          notes: string | null
          purchase_cost: number | null
          quantity: number
          reorder_level: number
          sku: string
          standard_cost: number | null
          status: string
          subcategory: string | null
          supplier_id: string | null
          unit: string
          updated_at: string
        }
        Insert: {
          aliases?: string[] | null
          category: Database["public"]["Enums"]["inventory_category"]
          created_at?: string
          default_location_id?: string | null
          id?: string
          import_notes?: string | null
          is_active?: boolean
          item_id?: string | null
          location?: string | null
          min_level?: number
          name: string
          notes?: string | null
          purchase_cost?: number | null
          quantity?: number
          reorder_level?: number
          sku: string
          standard_cost?: number | null
          status?: string
          subcategory?: string | null
          supplier_id?: string | null
          unit?: string
          updated_at?: string
        }
        Update: {
          aliases?: string[] | null
          category?: Database["public"]["Enums"]["inventory_category"]
          created_at?: string
          default_location_id?: string | null
          id?: string
          import_notes?: string | null
          is_active?: boolean
          item_id?: string | null
          location?: string | null
          min_level?: number
          name?: string
          notes?: string | null
          purchase_cost?: number | null
          quantity?: number
          reorder_level?: number
          sku?: string
          standard_cost?: number | null
          status?: string
          subcategory?: string | null
          supplier_id?: string | null
          unit?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_items_default_location_id_fkey"
            columns: ["default_location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
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
          location_id: string | null
          performed_by: string | null
          quantity: number
          reason: string | null
          related_production_batch: string | null
          source: string | null
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
          location_id?: string | null
          performed_by?: string | null
          quantity: number
          reason?: string | null
          related_production_batch?: string | null
          source?: string | null
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
          location_id?: string | null
          performed_by?: string | null
          quantity?: number
          reason?: string | null
          related_production_batch?: string | null
          source?: string | null
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
            foreignKeyName: "inventory_movements_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "v_item_stock"
            referencedColumns: ["item_id"]
          },
          {
            foreignKeyName: "inventory_movements_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
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
      locations: {
        Row: {
          created_at: string
          id: string
          is_default: boolean
          location_id: string
          location_type: string | null
          name: string
          notes: string | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_default?: boolean
          location_id: string
          location_type?: string | null
          name: string
          notes?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_default?: boolean
          location_id?: string
          location_type?: string | null
          name?: string
          notes?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
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
          {
            foreignKeyName: "production_batches_product_item_id_fkey"
            columns: ["product_item_id"]
            isOneToOne: false
            referencedRelation: "v_item_stock"
            referencedColumns: ["item_id"]
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
            foreignKeyName: "production_consumption_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "v_item_stock"
            referencedColumns: ["item_id"]
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
      purchase_order_items: {
        Row: {
          created_at: string
          id: string
          item_id: string
          purchase_order_id: string
          quantity_ordered: number
          quantity_received: number
          unit_cost: number | null
        }
        Insert: {
          created_at?: string
          id?: string
          item_id: string
          purchase_order_id: string
          quantity_ordered: number
          quantity_received?: number
          unit_cost?: number | null
        }
        Update: {
          created_at?: string
          id?: string
          item_id?: string
          purchase_order_id?: string
          quantity_ordered?: number
          quantity_received?: number
          unit_cost?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "purchase_order_items_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_items_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "v_item_stock"
            referencedColumns: ["item_id"]
          },
          {
            foreignKeyName: "purchase_order_items_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_orders: {
        Row: {
          created_at: string
          created_by: string | null
          expected_date: string | null
          id: string
          notes: string | null
          order_date: string
          po_number: string
          status: Database["public"]["Enums"]["purchase_order_status"]
          supplier_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          expected_date?: string | null
          id?: string
          notes?: string | null
          order_date?: string
          po_number: string
          status?: Database["public"]["Enums"]["purchase_order_status"]
          supplier_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          expected_date?: string | null
          id?: string
          notes?: string | null
          order_date?: string
          po_number?: string
          status?: Database["public"]["Enums"]["purchase_order_status"]
          supplier_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchase_orders_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      recipe_ingredients: {
        Row: {
          created_at: string
          id: string
          ingredient_item_id: string
          notes: string | null
          quantity: number | null
          recipe_id: string
          sort_order: number
          unit: string | null
          waste_pct: number | null
        }
        Insert: {
          created_at?: string
          id?: string
          ingredient_item_id: string
          notes?: string | null
          quantity?: number | null
          recipe_id: string
          sort_order?: number
          unit?: string | null
          waste_pct?: number | null
        }
        Update: {
          created_at?: string
          id?: string
          ingredient_item_id?: string
          notes?: string | null
          quantity?: number | null
          recipe_id?: string
          sort_order?: number
          unit?: string | null
          waste_pct?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "recipe_ingredients_ingredient_item_id_fkey"
            columns: ["ingredient_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recipe_ingredients_ingredient_item_id_fkey"
            columns: ["ingredient_item_id"]
            isOneToOne: false
            referencedRelation: "v_item_stock"
            referencedColumns: ["item_id"]
          },
          {
            foreignKeyName: "recipe_ingredients_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "recipes"
            referencedColumns: ["id"]
          },
        ]
      }
      recipes: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          product_item_id: string
          status: Database["public"]["Enums"]["recipe_status"]
          updated_at: string
          version: number
          waste_pct: number | null
          yield_quantity: number | null
          yield_unit: string | null
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          product_item_id: string
          status?: Database["public"]["Enums"]["recipe_status"]
          updated_at?: string
          version?: number
          waste_pct?: number | null
          yield_quantity?: number | null
          yield_unit?: string | null
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          product_item_id?: string
          status?: Database["public"]["Enums"]["recipe_status"]
          updated_at?: string
          version?: number
          waste_pct?: number | null
          yield_quantity?: number | null
          yield_unit?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "recipes_product_item_id_fkey"
            columns: ["product_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recipes_product_item_id_fkey"
            columns: ["product_item_id"]
            isOneToOne: false
            referencedRelation: "v_item_stock"
            referencedColumns: ["item_id"]
          },
        ]
      }
      sales_order_items: {
        Row: {
          created_at: string
          id: string
          item_id: string
          quantity: number
          sales_order_id: string
          unit_price: number | null
        }
        Insert: {
          created_at?: string
          id?: string
          item_id: string
          quantity: number
          sales_order_id: string
          unit_price?: number | null
        }
        Update: {
          created_at?: string
          id?: string
          item_id?: string
          quantity?: number
          sales_order_id?: string
          unit_price?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "sales_order_items_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_order_items_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "v_item_stock"
            referencedColumns: ["item_id"]
          },
          {
            foreignKeyName: "sales_order_items_sales_order_id_fkey"
            columns: ["sales_order_id"]
            isOneToOne: false
            referencedRelation: "sales_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      sales_orders: {
        Row: {
          created_at: string
          created_by: string | null
          customer_id: string | null
          fulfilled_at: string | null
          fulfilled_by: string | null
          id: string
          notes: string | null
          order_date: string
          order_number: string
          status: Database["public"]["Enums"]["sales_order_status"]
          updated_at: string
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          fulfilled_at?: string | null
          fulfilled_by?: string | null
          id?: string
          notes?: string | null
          order_date?: string
          order_number: string
          status?: Database["public"]["Enums"]["sales_order_status"]
          updated_at?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          fulfilled_at?: string | null
          fulfilled_by?: string | null
          id?: string
          notes?: string | null
          order_date?: string
          order_number?: string
          status?: Database["public"]["Enums"]["sales_order_status"]
          updated_at?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sales_orders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
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
          target_level: number
        }
        Insert: {
          created_at?: string
          id?: string
          item_id: string
          shop_id: string
          target_level?: number
        }
        Update: {
          created_at?: string
          id?: string
          item_id?: string
          shop_id?: string
          target_level?: number
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
            foreignKeyName: "shop_assortments_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "v_item_stock"
            referencedColumns: ["item_id"]
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
            foreignKeyName: "shop_stock_count_lines_count_id_fkey"
            columns: ["count_id"]
            isOneToOne: false
            referencedRelation: "v_shop_daily_balance"
            referencedColumns: ["closing_id"]
          },
          {
            foreignKeyName: "shop_stock_count_lines_count_id_fkey"
            columns: ["count_id"]
            isOneToOne: false
            referencedRelation: "v_shop_daily_balance"
            referencedColumns: ["opening_id"]
          },
          {
            foreignKeyName: "shop_stock_count_lines_count_id_fkey"
            columns: ["count_id"]
            isOneToOne: false
            referencedRelation: "v_shop_pending_closings"
            referencedColumns: ["closing_id"]
          },
          {
            foreignKeyName: "shop_stock_count_lines_count_id_fkey"
            columns: ["count_id"]
            isOneToOne: false
            referencedRelation: "v_shop_pending_closings"
            referencedColumns: ["opening_id"]
          },
          {
            foreignKeyName: "shop_stock_count_lines_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_stock_count_lines_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "v_item_stock"
            referencedColumns: ["item_id"]
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
            foreignKeyName: "stock_requests_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "v_item_stock"
            referencedColumns: ["item_id"]
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
          cancel_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
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
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
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
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
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
      v_item_location_stock: {
        Row: {
          item_id: string | null
          location_id: string | null
          on_hand: number | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_movements_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_movements_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "v_item_stock"
            referencedColumns: ["item_id"]
          },
          {
            foreignKeyName: "inventory_movements_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      v_item_stock: {
        Row: {
          category: Database["public"]["Enums"]["inventory_category"] | null
          item_code: string | null
          item_id: string | null
          min_level: number | null
          name: string | null
          on_hand: number | null
          reorder_level: number | null
          sku: string | null
          status: string | null
          subcategory: string | null
          unit: string | null
        }
        Relationships: []
      }
      v_shop_daily_balance: {
        Row: {
          actual_closing: number | null
          closing_id: string | null
          closing_status:
            | Database["public"]["Enums"]["stock_count_status"]
            | null
          count_date: string | null
          expected_closing: number | null
          item_id: string | null
          opening_id: string | null
          opening_qty: number | null
          opening_status:
            | Database["public"]["Enums"]["stock_count_status"]
            | null
          received: number | null
          restock_recommendation: number | null
          returned: number | null
          shop_id: string | null
          sold: number | null
          target_level: number | null
          variance: number | null
          wasted: number | null
        }
        Relationships: []
      }
      v_shop_pending_closings: {
        Row: {
          closing_id: string | null
          closing_status:
            | Database["public"]["Enums"]["stock_count_status"]
            | null
          count_date: string | null
          opening_id: string | null
          shop_id: string | null
          shop_name: string | null
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
      v_shop_top_restock: {
        Row: {
          actual_closing: number | null
          count_date: string | null
          item_id: string | null
          item_name: string | null
          restock_recommendation: number | null
          shop_id: string | null
          shop_name: string | null
          sku: string | null
          target_level: number | null
          unit: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      approve_recipe: { Args: { _recipe_id: string }; Returns: undefined }
      approve_stock_request: {
        Args: { _notes?: string; _request_id: string }
        Returns: string
      }
      bootstrap_allowed: { Args: never; Returns: boolean }
      cancel_user_invite: {
        Args: { _invite_id: string; _reason: string }
        Returns: undefined
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
      delete_shop_stock_count: {
        Args: { _count_id: string }
        Returns: undefined
      }
      fulfill_sales_order: { Args: { _order_id: string }; Returns: undefined }
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
      receive_purchase_order: {
        Args: { _lines: Json; _po_id: string }
        Returns: undefined
      }
      record_location_stock_count: {
        Args: {
          _item_id: string
          _location_id: string
          _physical_qty: number
          _reason: string
        }
        Returns: string
      }
      record_manual_movement: {
        Args: {
          _item_id: string
          _location_id: string
          _quantity: number
          _reason: string
          _type: Database["public"]["Enums"]["movement_type"]
        }
        Returns: string
      }
      set_user_active_status: {
        Args: {
          _is_active: boolean
          _reason: string
          _target_user_id: string
        }
        Returns: undefined
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
      record_stock_adjustment: {
        Args: {
          _direction: string
          _item_id: string
          _quantity: number
          _reason: string
        }
        Returns: string
      }
      reject_stock_request: {
        Args: { _notes: string; _request_id: string }
        Returns: undefined
      }
      submit_shop_stock_count: {
        Args: { _count_id: string }
        Returns: undefined
      }
      void_sales_order: {
        Args: { _order_id: string; _reason: string }
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
